import json
import boto3
import time
import os

def create_cache_behavior(origin_domain, cache_policy_id, origin_request_policy_id):
    return {
        'TargetOriginId': origin_domain,
        'ViewerProtocolPolicy': 'allow-all',
        'AllowedMethods': {
            'Quantity': 7,
            'Items': ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
            'CachedMethods': {
                'Quantity': 2,
                'Items': ['GET', 'HEAD']
            }
        },
        'CachePolicyId': cache_policy_id,
        'OriginRequestPolicyId': origin_request_policy_id
    }

def lambda_handler(event, context):
    cloudfront_client = boto3.client('cloudfront')
    dynamodb = boto3.resource('dynamodb')
    
    cert_arn = event['CertificateArn']
    domain_name = event['DomainName']
    origin_domain = event['OriginDomain']
    web_acl_arn = event['webAclArn']
    cache_policy_id = os.environ['CACHE_POLICY_ID'] # custom Cache Policy for the cloudflare default TTL
    table = dynamodb.Table(os.environ['TABLE_NAME'])
    migration_id = event['migration_id']
    
    # default cache behavior
    default_cache_policy_id = '4cc15a8a-d715-48a4-82b8-cc0b614638fe'  # UseOriginCacheControlHeaders-QueryStrings managed policy
    origin_request_policy_id = '216adef6-5c7f-47e4-b989-5492eafa07d3'  # AllViewer managed policy
    default_cache_behavior = create_cache_behavior(origin_domain, default_cache_policy_id, origin_request_policy_id)
    
    # additional cache behaviors
    cache_behavior_path_patterns = [
        '*.html', '*.css', '*.js', '*.json', '*.svg', '*.jpg', '*.jpeg',
        '*.gif', '*.webp', '*.woff', '*.woff2', '*.mp4', '*.webm'
    ]
    cache_behaviors = []
    for pattern in cache_behavior_path_patterns:
        behavior = create_cache_behavior(origin_domain, cache_policy_id, origin_request_policy_id)
        behavior['PathPattern'] = pattern
        cache_behaviors.append(behavior)
    
    
    distribution_config = {
        'CallerReference': str(time.time()),
        'Aliases': {
            'Quantity': 1,
            'Items': [domain_name]
        },
        'DefaultRootObject': '',
        'Origins': {
            'Quantity': 1,
            'Items': [
                {
                    'Id': origin_domain,
                    'DomainName': origin_domain,
                    'CustomOriginConfig': {
                        'HTTPPort': 80,
                        'HTTPSPort': 443,
                        'OriginProtocolPolicy': 'match-viewer',
                        'OriginSslProtocols': {
                            'Quantity': 1,
                            'Items': ['TLSv1.2']
                        }
                    }
                }
            ]
        },
        'DefaultCacheBehavior': default_cache_behavior,
        'CacheBehaviors': {
            'Quantity': len(cache_behaviors),
            'Items': cache_behaviors
        },
        'Comment': 'CloudFront distribution created by Step Functions',
        'Enabled': True,
        'ViewerCertificate': {
            'ACMCertificateArn': cert_arn,
            'SSLSupportMethod': 'sni-only',
            'MinimumProtocolVersion': 'TLSv1.2_2018'
        },
        'PriceClass': 'PriceClass_100',
        'WebACLId': web_acl_arn
    }
    
    try:
        response = cloudfront_client.create_distribution(
            DistributionConfig=distribution_config
        )
        
        # Update DynamoDB record
        table.update_item(
            Key={
                'migration_id': migration_id,
                'dns_record': domain_name
            },
            UpdateExpression="SET step_name = :n, #status = :s, #time = :t",
            ExpressionAttributeNames={
                '#status': 'status',
                '#time': 'time'
            },
            ExpressionAttributeValues={
                ':n': 'Create CloudFront Distribution',
                ':s': 'SUCCEEDED',
                ':t': int(time.time())
            }
        )
        
        return {
            'status': 'success',
            'message': 'CloudFront distribution successfully created',
            'DistributionId': response['Distribution']['Id'],
            'DistributionCname': response['Distribution']['DomainName']
        }
        
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}")
        error_message = str(e)
        
        # Update DynamoDB record with error state
        try:
            table.update_item(
                Key={
                    'migration_id': migration_id,
                    'dns_record': domain_name
                },
                UpdateExpression="SET step_name = :n, #status = :s, error_message = :e, #time = :t",
                ExpressionAttributeNames={
                    '#status': 'status',
                    '#time': 'time'
                },
                ExpressionAttributeValues={
                    ':n': 'Create CloudFront Distribution',
                    ':s': 'FAILED',
                    ':e': str(e),
                    ':t': int(time.time())
                }
            )
        except Exception as ddb_error:
            error_message += f" Additionally, failed to update DynamoDB: {str(ddb_error)}"
        
        raise Exception(f'Error occurred: {error_message}')   
