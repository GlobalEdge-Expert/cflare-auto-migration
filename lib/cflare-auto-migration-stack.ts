import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

function createLambdaRole(scope: Construct, id: string, policyStatements: cdk.aws_iam.PolicyStatement[]): cdk.aws_iam.Role {
  const role = new cdk.aws_iam.Role(scope, `${id}Role`, {
    assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
  });

  role.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));

  policyStatements.forEach(statement => role.addToPolicy(statement));

  return role;
}

function createHandleErrorTask(
  scope: Construct,
  stepName: string,
  handleErrorLambda: cdk.aws_lambda.Function
): cdk.aws_stepfunctions.IChainable {
  // Step Function Task for handling errors dynamically
  const handleErrorTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(scope, `Handle Error - ${stepName}`, {
    lambdaFunction: handleErrorLambda,
    resultPath: '$.errorInfo', // Use the dynamic resultPath input
    payloadResponseOnly: true,
    payload: cdk.aws_stepfunctions.TaskInput.fromObject({
      "viewer_domain": cdk.aws_stepfunctions.JsonPath.stringAt("$.viewer_domain"),
      "migration_id":  cdk.aws_stepfunctions.JsonPath.stringAt("$.migration_id"),
      "step_name": stepName,
      "error": cdk.aws_stepfunctions.JsonPath.stringAt('$.error')
    })
  });

  return handleErrorTask;
}

export class CflareAutoMigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stackId = cdk.Stack.of(this).stackId;
    const assetDir = path.join(__dirname, '../asset');
    const lambdaDir = assetDir + '/lambda';

    // create s3. 
    const htmlBucket = new cdk.aws_s3.Bucket(this, 'HTMLBucket', {
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // create a s3 deployment that copies from ./asset folder to the bucket.
    new cdk.aws_s3_deployment.BucketDeployment(this, 'S3deploymentToHTMLBucket', {
      sources: [cdk.aws_s3_deployment.Source.asset(assetDir + '/html')],
      destinationBucket: htmlBucket,
    });

    // create a cloudfront OAC.
    const cloudfrontOAC = new cdk.aws_cloudfront.OriginAccessIdentity(this, 'CloudfrontOAC', {
      comment: 'OAC for ' + stackId,
    });

    // create a s3 bucket policy for the bucket and OAC.
    const s3BucketPolicy = new cdk.aws_iam.PolicyStatement({
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [cloudfrontOAC.grantPrincipal],
      resources: [htmlBucket.arnForObjects('*')],
    });

    // create an API gateway and a lambda function behind it.
    const apiGateway = new cdk.aws_apigateway.RestApi(this, 'APIgw', {
      deployOptions: {
        stageName: 'api',
      },
      endpointConfiguration: {
        types: [cdk.aws_apigateway.EndpointType.REGIONAL],
      },
    });

    // service role for Lambda that includes default lambda policy and route 53 admin policy, and an inline policy.
    const lambdaQuickMigrationRole = new cdk.aws_iam.Role(this, 'lambdaQuickMigrationRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRoute53FullAccess'),
      ],
      inlinePolicies: {
        'lambdaQuickMigrationPolicy': new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['states:*'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const lambdaQuickMigration = new cdk.aws_lambda.Function(this, 'LambdaQuickMigration', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir+'/quick-migration'),
      handler: 'index.lambda_handler',
      timeout: cdk.Duration.seconds(15),
      role: lambdaQuickMigrationRole,
    });

    // create a lambda integration with the API gateway and the lambda function
    const lambdaQuickMigrationIntegration = new cdk.aws_apigateway.LambdaIntegration(lambdaQuickMigration);

    // create a resource and map it to the lambda integration
    const apiQuickMigrationResource = apiGateway.root.addResource('quick-migration');

    // add the integration to the resource
    apiQuickMigrationResource.addMethod('POST', lambdaQuickMigrationIntegration);

    // lambda@edge function that triggers as origin request
    const lambdaedgeIndexhtml = new cdk.aws_lambda.Function(this, 'LambdaEdgeIndexHtml', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
      code: cdk.aws_lambda.Code.fromInline(`'use strict';
      exports.handler = (event, context, callback) => {
        var request = event.Records[0].cf.request;
        request.uri = request.uri.replace(/\\/$/,'\\/index.html');
        return callback(null, request);
      }`),
      handler: 'index.handler',
    });

    // Create DynamoDB table for Cloudflare to CloudFront migration tracking
    const migrationTable = new cdk.aws_dynamodb.Table(this, 'MigrationTable', {
      partitionKey: { name: 'migration_id', type: cdk.aws_dynamodb.AttributeType.STRING },
      sortKey: { name: 'start_time', type: cdk.aws_dynamodb.AttributeType.NUMBER },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const MigrationHistoryLambdaRole = createLambdaRole(this, 'MigrationHistory', []);
    const lambdaMigrationHistory = new cdk.aws_lambda.Function(this, 'lambdaMigrationHistory', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir+'/migration-history'),
      handler: 'index.lambda_handler',
      timeout: cdk.Duration.seconds(15),
      role: MigrationHistoryLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName,
      }
    });
    migrationTable.grantReadData(lambdaMigrationHistory)

    // create a lambda integration with the API gateway and the lambda function
    const lambdaMigrationHistoryIntegration = new cdk.aws_apigateway.LambdaIntegration(lambdaMigrationHistory);

    // create a resource and map it to the lambda integration
    const apiMigrationHistoryResource = apiGateway.root.addResource('migration-history');

    // add the integration to the resource
    apiMigrationHistoryResource.addMethod('GET', lambdaMigrationHistoryIntegration);


    // create a cloudfront distribution with the S3 bucket, OAC, and the api gateway.
    const cloudfrontDistributionS3WithError = new cdk.aws_cloudfront.Distribution(this, 'CflareAutoMigrationDistributionS3WithError', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new cdk.aws_cloudfront_origins.S3Origin(htmlBucket, {
          originAccessIdentity: cloudfrontOAC,
        }),
        edgeLambdas: [
          {
            functionVersion: lambdaedgeIndexhtml.currentVersion,
            eventType: cdk.aws_cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
          },
        ],
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new cdk.aws_cloudfront_origins.RestApiOrigin(apiGateway, {
            originPath: '',
          }),
          allowedMethods: cdk.aws_cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cdk.aws_cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cdk.aws_cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      errorResponses: [
        {
          httpStatus: 404,
          responsePagePath: '/404.html',
        },
        {
          httpStatus: 403,
          responsePagePath: '/404.html',
        },
      ],
    });

    // create custom cache policy (cloudflare default cache TTL - 120m)
    const custom_cloudflareCachePolicy = new cdk.aws_cloudfront.CachePolicy(this, 'CustomCachePolicy', {
      cachePolicyName: 'cloduflareCustomCachePolicy',
      comment: 'Custom cache policy with specific headers and all query strings for cloudflare',
      defaultTtl: cdk.Duration.minutes(120),
      minTtl: cdk.Duration.seconds(1),
      maxTtl: cdk.Duration.days(365),
      headerBehavior: cdk.aws_cloudfront.CacheHeaderBehavior.allowList(
        'x-method-override',
        'origin',
        'host',
        'x-http-method',
        'x-http-method-override'
      ),
      queryStringBehavior: cdk.aws_cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // create a stepfunction to deploy cloudfront distributions in a DNS Zone.
    const account = cdk.Stack.of(this).account;

    // Lambda function definitions
    const createACMCertificateLambdaRole = createLambdaRole(this, 'CreateACMCertificate', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['acm:RequestCertificate', 'acm:DescribeCertificate', 'acm:GetCertificate', 'acm:ListCertificates'],
        resources: [`arn:aws:acm:us-east-1:${this.account}:certificate/*`],
      })
    ]);
    const createACMCertificateLambda = new cdk.aws_lambda.Function(this, 'CreateACMCertificateLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,  // Replace with the runtime you're using
      handler: 'CreateACMCertificate.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      timeout: cdk.Duration.seconds(10),
      role: createACMCertificateLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName,
      }
    });

    const createValidationRecordInCloudflareLambdaRole = createLambdaRole(this, 'createValidationRecordInCloudflare', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['acm:DescribeCertificate'],
        resources: [`arn:aws:acm:us-east-1:${this.account}:certificate/*`],
      }),
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['route53:ChangeResourceRecordSets'],
        resources: ['arn:aws:route53:::hostedzone/*'],
      }),
    ]);
    const createValidationRecordInCloudflareLambda = new cdk.aws_lambda.Function(this, 'CreateValidationRecordInCloudflareLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'CreateValidationRecordInCloudflare.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      timeout: cdk.Duration.seconds(10),
      role: createValidationRecordInCloudflareLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName,
      }
    });

    const checkValidationStatusLambdaRole = createLambdaRole(this, 'checkValidationStatus', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['acm:DescribeCertificate'],
        resources: [`arn:aws:acm:us-east-1:${this.account}:certificate/*`],
      })
    ]);
    const checkValidationStatusLambda = new cdk.aws_lambda.Function(this, 'CheckValidationStatusLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'CheckValidationStatus.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      role: checkValidationStatusLambdaRole
    });

    const createOriginRecordLambdaRole = createLambdaRole(this, 'createOriginRecord', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['route53:ChangeResourceRecordSets', 'route53:GetHostedZone', 'route53:ListResourceRecordSets'],
        resources: ['arn:aws:route53:::hostedzone/*'],
      })
    ]);
    const createOriginRecordLambda = new cdk.aws_lambda.Function(this, 'CreateOriginRecordLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'CreateOriginRecord.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      timeout: cdk.Duration.seconds(10),
      role: createOriginRecordLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName,
      }
    });

    const createWebACLLambdaRole = createLambdaRole(this, 'createWebACL', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['wafv2:CreateWebACL'],
        resources: ['*'],
      })
    ]);
    const createWebACLLambda = new cdk.aws_lambda.Function(this, 'createWebACLLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'createWebACL.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      timeout: cdk.Duration.seconds(10),
      role: createWebACLLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName,
      }
    });

    const createCloudFrontDistributionLambdaRole = createLambdaRole(this, 'createCloudFrontDistribution', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['cloudfront:CreateDistribution', 'wafv2:GetWebACL', 'wafv2:ListWebACLs'],
        resources: ['*'],
      })
    ]);
    const createCloudFrontDistributionLambda = new cdk.aws_lambda.Function(this, 'CreateCloudFrontDistributionLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'CreateCloudFrontDistribution.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      timeout: cdk.Duration.seconds(30),
      role: createCloudFrontDistributionLambdaRole,
      environment: {
        CACHE_POLICY_ID: custom_cloudflareCachePolicy.cachePolicyId,
        TABLE_NAME: migrationTable.tableName,
      }
    });

    const checkCFDistributionStatusLambdaRole = createLambdaRole(this, 'checkCFDistributionStatus', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['cloudfront:GetDistribution'],
        resources: ['*'],
      })
    ]);
    const checkCFDistributionStatusLambda = new cdk.aws_lambda.Function(this, 'CheckCFDistributionStatusLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'CheckCFDistributionStatus.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      role: checkCFDistributionStatusLambdaRole
    });

    const updateDNSRecordLambdaRole = createLambdaRole(this, 'updateDNSRecord', [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets'],
        resources: ['arn:aws:route53:::hostedzone/*'],
      })
    ]);
    const updateDNSRecordLambda = new cdk.aws_lambda.Function(this, 'UpdateDNSRecordLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'UpdateDNSRecord.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      timeout: cdk.Duration.seconds(10),
      role: updateDNSRecordLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName,
      },
    });

    const HandleErrorLambdaRole = createLambdaRole(this, 'HandleError', []);
    const handleErrorLambda = new cdk.aws_lambda.Function(this, 'HandleErrorLambda', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_12,
      handler: 'HandleError.lambda_handler',
      code: cdk.aws_lambda.Code.fromAsset(lambdaDir + '/stepfunctions_lambda'),
      role: HandleErrorLambdaRole,
      environment: {
        TABLE_NAME: migrationTable.tableName
      }
    });

    // Grant write permissions to the DynamoDB table
    migrationTable.grantWriteData(lambdaQuickMigration)
    migrationTable.grantWriteData(createACMCertificateLambda)
    migrationTable.grantWriteData(createValidationRecordInCloudflareLambda)
    migrationTable.grantWriteData(createOriginRecordLambda)
    migrationTable.grantWriteData(createWebACLLambda)
    migrationTable.grantWriteData(createCloudFrontDistributionLambda)
    migrationTable.grantWriteData(updateDNSRecordLambda)
    migrationTable.grantWriteData(handleErrorLambda)
    
    // Step Function Tasks
    const createACMCertificateTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Create ACM Certificate', {
      lambdaFunction: createACMCertificateLambda,
      resultPath: '$.certificateDetails',
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "viewer_domain": cdk.aws_stepfunctions.JsonPath.stringAt("$.viewer_domain"),
        "migration_id":  cdk.aws_stepfunctions.JsonPath.stringAt("$.migration_id"),
      })
    }).addCatch(createHandleErrorTask(this, 'Create ACM Certificate', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const waitForValidationRecord = new cdk.aws_stepfunctions.Wait(this, 'Wait For Validation Record', {
      time: cdk.aws_stepfunctions.WaitTime.duration(cdk.Duration.seconds(30))
    });

    const createValidationRecordTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Create Validation Record in Cloudflare', {
      lambdaFunction: createValidationRecordInCloudflareLambda,
      resultPath: '$.validationDetails',
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "CertificateArn": cdk.aws_stepfunctions.JsonPath.stringAt("$.certificateDetails.CertificateArn"),
        "CloudflareZoneID": cdk.aws_stepfunctions.JsonPath.stringAt("$.CloudflareZoneID"),
        "CloudflareAPIKey": cdk.aws_stepfunctions.JsonPath.stringAt("$.CloudflareAPIKey"),
        "ZoneID": cdk.aws_stepfunctions.JsonPath.stringAt("$.ZoneID"),
        "migration_id":  cdk.aws_stepfunctions.JsonPath.stringAt("$.migration_id"),
      })
    }).addCatch(createHandleErrorTask(this, 'Create Validation Record in Cloudflare', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const checkValidationStatusTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Check Validation Status', {
      lambdaFunction: checkValidationStatusLambda,
      resultPath: '$.validationStatus',
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "CertificateArn": cdk.aws_stepfunctions.JsonPath.stringAt("$.certificateDetails.CertificateArn")
      })
    }).addCatch(createHandleErrorTask(this, 'Check Validation Status', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const waitForCertValidation = new cdk.aws_stepfunctions.Wait(this, 'Wait For Cert Validation', {
      time: cdk.aws_stepfunctions.WaitTime.duration(cdk.Duration.seconds(30))
    });

    const isValidatedChoice = new cdk.aws_stepfunctions.Choice(this, 'Is Validated?');

    const createOriginRecordTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Create Origin Record', {
      lambdaFunction: createOriginRecordLambda,
      resultPath: '$.OriginDomain',
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "DomainName": cdk.aws_stepfunctions.JsonPath.stringAt("$.certificateDetails.DomainName"),
        "origin_info": cdk.aws_stepfunctions.JsonPath.objectAt("$.origin_info"),
        "ZoneID": cdk.aws_stepfunctions.JsonPath.stringAt("$.ZoneID"),
        "CloudflareZoneID": cdk.aws_stepfunctions.JsonPath.stringAt("$.CloudflareZoneID"),
        "CloudflareAPIKey": cdk.aws_stepfunctions.JsonPath.stringAt("$.CloudflareAPIKey"),
        "migration_id":  cdk.aws_stepfunctions.JsonPath.stringAt("$.migration_id"),
      })
    }).addCatch(createHandleErrorTask(this, 'Create Origin Record', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const setOriginDomainDirectly = new cdk.aws_stepfunctions.Pass(this, 'Set Origin Domain Directly', {
      parameters: {
        'OriginDomain.$': '$.origin_info.value'
      },
      resultPath: '$.OriginDomain',
    });

    const checkIfOriginIsIPChoice = new cdk.aws_stepfunctions.Choice(this, 'Check If Origin Is IP');

    const createWebACLTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Create Web ACL', {
      lambdaFunction: createWebACLLambda,
      resultPath: '$.webAclDetails',
      payloadResponseOnly: true,
    }).addCatch(createHandleErrorTask(this, 'Create Web ACL', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const createCloudFrontDistributionTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Create CloudFront Distribution', {
      lambdaFunction: createCloudFrontDistributionLambda,
      resultPath: '$.distributionDetails',
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "CertificateArn": cdk.aws_stepfunctions.JsonPath.stringAt("$.certificateDetails.CertificateArn"),
        "DomainName": cdk.aws_stepfunctions.JsonPath.stringAt("$.certificateDetails.DomainName"),
        "OriginDomain": cdk.aws_stepfunctions.JsonPath.stringAt("$.OriginDomain.OriginDomain"),
        "webAclArn": cdk.aws_stepfunctions.JsonPath.stringAt("$.webAclDetails.webAclArn"),
        "migration_id":  cdk.aws_stepfunctions.JsonPath.stringAt("$.migration_id"),
      })
    }).addCatch(createHandleErrorTask(this, 'Create CloudFront Distribution', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const waitForCFDistribution = new cdk.aws_stepfunctions.Wait(this, 'Wait For CF Distribution', {
      time: cdk.aws_stepfunctions.WaitTime.duration(cdk.Duration.seconds(60))
    });

    const checkCFDistributionStatusTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Check CloudFront Distribution Status', {
      lambdaFunction: checkCFDistributionStatusLambda,
      resultPath: '$.distributionStatus',
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "DistributionId": cdk.aws_stepfunctions.JsonPath.stringAt("$.distributionDetails.DistributionId")
      })
    }).addCatch(createHandleErrorTask(this, 'Check CloudFront Distribution Status', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    const isDistributionDeployedChoice = new cdk.aws_stepfunctions.Choice(this, 'IsDistributionDeployed');

    const updateDNSRecordTask = new cdk.aws_stepfunctions_tasks.LambdaInvoke(this, 'Update DNS Record', {
      lambdaFunction: updateDNSRecordLambda,
      payloadResponseOnly: true,
      payload: cdk.aws_stepfunctions.TaskInput.fromObject({
        "viewer_domain": cdk.aws_stepfunctions.JsonPath.stringAt("$.viewer_domain"),
        "CNAME": cdk.aws_stepfunctions.JsonPath.stringAt("$.distributionDetails.DistributionCname"),
        "ZoneID": cdk.aws_stepfunctions.JsonPath.stringAt("$.ZoneID"),
        "migration_id":  cdk.aws_stepfunctions.JsonPath.stringAt("$.migration_id"),
      })
    }).addCatch(createHandleErrorTask(this, 'Update DNS Record', handleErrorLambda), {
      errors: ['States.ALL'],
      resultPath: '$.error'
    });

    // Define the main flow
    const definition = createACMCertificateTask
      .next(waitForValidationRecord)
      .next(createValidationRecordTask)
      .next(checkValidationStatusTask)
      .next(isValidatedChoice);

    // Define the validation choice
    isValidatedChoice
      .when(cdk.aws_stepfunctions.Condition.stringEquals('$.validationStatus.ValidationStatus', 'SUCCESS'), checkIfOriginIsIPChoice)
      .otherwise(waitForCertValidation.next(checkValidationStatusTask));

    // Define the origin choice
    checkIfOriginIsIPChoice
      .when(cdk.aws_stepfunctions.Condition.stringEquals('$.origin_info.type', 'A'), createOriginRecordTask)
      .otherwise(setOriginDomainDirectly);

    // Continue the flow after origin choice
    createOriginRecordTask.next(createWebACLTask);
    setOriginDomainDirectly.next(createWebACLTask);

    createWebACLTask
      .next(createCloudFrontDistributionTask)
      .next(waitForCFDistribution)
      .next(checkCFDistributionStatusTask)
      .next(isDistributionDeployedChoice);

    // Define the distribution deployed choice
    isDistributionDeployedChoice
      .when(cdk.aws_stepfunctions.Condition.stringEquals('$.distributionStatus.Status', 'Deployed'), updateDNSRecordTask)
      .otherwise(waitForCFDistribution);

    // Create the Step Function
    const stepFunctionlambdaFunctions = [
      createACMCertificateLambda,
      createValidationRecordInCloudflareLambda,
      checkValidationStatusLambda,
      createOriginRecordLambda,
      createWebACLLambda,
      createCloudFrontDistributionLambda,
      checkCFDistributionStatusLambda,
      updateDNSRecordLambda,
    ];

    const stepFunctionLambdaArns = stepFunctionlambdaFunctions.map(fn => fn.functionArn);

    // Step Functions Exceuction Role
    const stepFunctionRole = new cdk.aws_iam.Role(this, 'StepFunctionRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('states.amazonaws.com'),
    });
    stepFunctionRole.addToPolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: stepFunctionLambdaArns,
    }));

    const my_state_machine = new cdk.aws_stepfunctions.StateMachine(this, 'migrationCloudflare', {
      definition,
      timeout: cdk.Duration.minutes(30),
      role: stepFunctionRole
    });

    console.log(my_state_machine.stateMachineArn)
    lambdaQuickMigration.addEnvironment("STEP_FUNCTION_ARN", my_state_machine.stateMachineArn)
    lambdaQuickMigration.addEnvironment("TABLE_NAME", migrationTable.tableName)
  }
}