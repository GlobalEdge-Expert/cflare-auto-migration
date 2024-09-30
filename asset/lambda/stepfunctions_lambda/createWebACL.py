import boto3
import uuid
import os
import time

def lambda_handler(event, context):
    wafv2_client = boto3.client('wafv2')
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['TABLE_NAME'])
    
    # Retrieve parameters passed from Step Functions
    migration_id = event['migration_id']
    dns_record = event['viewer_domain']
    
    try:
        # Generate a unique identifier
        unique_id = str(uuid.uuid4())

        # Define the WebACL with the specified rules and append the UUID to the Name
        response = wafv2_client.create_web_acl(
            Name=f'cflare-Migration-WAF-{unique_id}',
            Scope='CLOUDFRONT',  # Change to 'REGIONAL' if not using CloudFront
            DefaultAction={'Allow': {}},  # Set the default action to Allow or Block
            Description='WebACL with AWS managed rules',
            Rules=[
                {
                    'Name': f'AWS-AWSManagedRulesAmazonIpReputationList',
                    'Priority': 0,
                    'Statement': {
                        'ManagedRuleGroupStatement': {
                            'VendorName': 'AWS',
                            'Name': 'AWSManagedRulesAmazonIpReputationList'
                        }
                    },
                    'OverrideAction': {"None": {}},
                    'VisibilityConfig': {
                        'SampledRequestsEnabled': True,
                        'CloudWatchMetricsEnabled': True,
                        'MetricName': f'AWS-AWSManagedRulesAmazonIpReputationList'
                    }
                },
                {
                    'Name': f'AWS-AWSManagedRulesCommonRuleSet',
                    'Priority': 1,
                    'Statement': {
                        'ManagedRuleGroupStatement': {
                            'VendorName': 'AWS',
                            'Name': 'AWSManagedRulesCommonRuleSet'
                        }
                    },
                    'OverrideAction': {"None": {}},
                    'VisibilityConfig': {
                        'SampledRequestsEnabled': True,
                        'CloudWatchMetricsEnabled': True,
                        'MetricName': f'AWS-AWSManagedRulesCommonRuleSet'
                    }
                },
                {
                    'Name': f'AWS-AWSManagedRulesKnownBadInputsRuleSet',
                    'Priority': 2,
                    'Statement': {
                        'ManagedRuleGroupStatement': {
                            'VendorName': 'AWS',
                            'Name': 'AWSManagedRulesKnownBadInputsRuleSet'
                        }
                    },
                    'OverrideAction': {"None": {}},
                    'VisibilityConfig': {
                        'SampledRequestsEnabled': True,
                        'CloudWatchMetricsEnabled': True,
                        'MetricName': f'AWS-AWSManagedRulesKnownBadInputsRuleSet'
                    }
                }
            ],
            VisibilityConfig={
                'SampledRequestsEnabled': True,
                'CloudWatchMetricsEnabled': True,
                'MetricName': f'MyWebACL-{unique_id}'
            }
        )
        
        print("Response from WAF:", response)
        web_acl_arn = response['Summary']['ARN']
        
        # Update DynamoDB record
        table.update_item(
            Key={
                'migration_id': migration_id,
                'dns_record': dns_record
            },
            UpdateExpression="SET step_name = :n, #status = :s, #time = :t",
            ExpressionAttributeNames={
                '#status': 'status',
                '#time': 'time'
            },
            ExpressionAttributeValues={
                ':n': 'Create Web ACL',
                ':s': 'SUCCEEDED',
                ':t': int(time.time())
            }
        )
        
        return {
            'status': 'success',
            'message': 'Web ACL successfully created',
            'webAclArn': web_acl_arn
        }
    
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}")
        error_message = str(e)
        
        # Update DynamoDB record with error state
        try:
            table.update_item(
                Key={
                    'migration_id': migration_id,
                    'dns_record': dns_record
                },
                UpdateExpression="SET step_name = :n, #status = :s, error_message = :e, #time = :t",
                ExpressionAttributeNames={
                    '#status': 'status',
                    '#time': 'time'
                },
                ExpressionAttributeValues={
                    ':n': 'Create Web ACL',
                    ':s': 'FAILED',
                    ':e': str(e),
                    ':t': int(time.time())
                }
            )
        except Exception as ddb_error:
            error_message += f" Additionally, failed to update DynamoDB: {str(ddb_error)}"
        
        raise Exception(f'Error occurred: {error_message}')