import boto3
import os
import time

def lambda_handler(event, context):
    acm_client = boto3.client('acm', region_name='us-east-1')
    dynamodb = boto3.resource('dynamodb')
    
    viewer_domain = event['viewer_domain']
    table = dynamodb.Table(os.environ['TABLE_NAME'])
    migration_id = event['migration_id']
    
    try:
        response = acm_client.request_certificate(
            DomainName=viewer_domain,
            ValidationMethod='DNS'
        )
        
        # Update DynamoDB record
        table.update_item(
            Key={
                'migration_id': migration_id,
                'dns_record': viewer_domain
            },
            UpdateExpression="SET step_name = :n, #status = :s, #time = :t",
            ExpressionAttributeNames={
                '#status': 'status',
                '#time': 'time'
            },
            ExpressionAttributeValues={
                ':n': 'Create ACM Certificate',
                ':s': 'SUCCEEDED',
                ':t': int(time.time())
            }
        )
        
        return {
            'status': 'success',
            'message': f'ACM Certificate successfully created for the domain {viewer_domain}',
            'CertificateArn': response['CertificateArn'],
            'DomainName': viewer_domain
        }
        
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}")
        error_message = str(e)
        
        # Update DynamoDB record with error state
        try:
            table.update_item(
                Key={
                    'migration_id': migration_id,
                    'dns_record': viewer_domain
                },
                UpdateExpression="SET step_name = :n, #status = :s, error_message = :e, #time = :t",
                ExpressionAttributeNames={
                    '#status': 'status',
                    '#time': 'time'
                },
                ExpressionAttributeValues={
                    ':n': 'Create ACM Certificate',
                    ':s': 'FAILED',
                    ':e': str(e),
                    ':t': int(time.time())
                }
            )
        except Exception as ddb_error:
            error_message += f" Additionally, failed to update DynamoDB: {str(ddb_error)}"
        
        raise Exception(f'Error occurred: {error_message}')        
