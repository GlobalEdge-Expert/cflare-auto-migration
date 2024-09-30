import boto3
import os
import time

def lambda_handler(event, context):
    # Initialize AWS resource client
    route53_client = boto3.client('route53')
    dynamodb = boto3.resource('dynamodb')

    # Retrieve parameters passed from Step Functions
    viewer_domain = event['viewer_domain']
    cname_target = event['CNAME']
    hosted_zone_id = event['ZoneID']  # Route 53 hosted zone ID
    table = dynamodb.Table(os.environ['TABLE_NAME'])
    migration_id = event['migration_id']

    try:
        # Delete the existing A record
        existing_records = route53_client.list_resource_record_sets(
            HostedZoneId=hosted_zone_id,
            StartRecordName=viewer_domain,
            StartRecordType='A',
            MaxItems='1'
        )
        
        if existing_records['ResourceRecordSets']:
            record = existing_records['ResourceRecordSets'][0]
            if record['Name'] == f"{viewer_domain}." and record['Type'] == 'A':
                response = route53_client.change_resource_record_sets(
                    HostedZoneId=hosted_zone_id,
                    ChangeBatch={
                        'Changes': [
                            {
                                'Action': 'DELETE',
                                'ResourceRecordSet': record
                            }
                        ]
                    }
                )

        # Create a new CNAME record
        response = route53_client.change_resource_record_sets(
            HostedZoneId=hosted_zone_id,
            ChangeBatch={
                'Changes': [
                    {
                        'Action': 'CREATE',
                        'ResourceRecordSet': {
                            'Name': viewer_domain,
                            'Type': 'CNAME',
                            'TTL': 300,
                            'ResourceRecords': [{'Value': cname_target}]
                        }
                    }
                ]
            }
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
                ':n': 'Update DNS Record',
                ':s': 'COMPLETED',
                ':t': int(time.time())
            }
        )

        # Return a successful response
        return {
            'status': 'success',
            'message': 'DNS record successfully updated to CloudFront domain and migration status marked as completed'
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
                    ':n': 'Update DNS Record',
                    ':s': 'FAILED',
                    ':e': str(e),
                    ':t': int(time.time())
                }
            )
        except Exception as ddb_error:
            error_message += f" Additionally, failed to update DynamoDB: {str(ddb_error)}"
        
        raise Exception(f'Error occurred: {error_message}')
