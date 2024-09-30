import json
import urllib.request
import urllib.parse
import boto3
import os
import time

def lambda_handler(event, context):
    route53_client = boto3.client('route53')
    acm_client = boto3.client('acm', region_name='us-east-1')
    dynamodb = boto3.resource('dynamodb')
    
    # Input parameters from the event
    cert_arn = event['CertificateArn']
    route53zoneID = event['ZoneID']
    cloudflare_api_key = event['CloudflareAPIKey']
    cloudflare_zone_id = event['CloudflareZoneID']
    table = dynamodb.Table(os.environ['TABLE_NAME'])
    migration_id = event['migration_id']
    domain_name = ""
    
    try:
        cert_details = acm_client.describe_certificate(CertificateArn=cert_arn)
        validation_record = cert_details['Certificate']['DomainValidationOptions'][0]['ResourceRecord']
        domain_name = cert_details['Certificate']['DomainName']
        
        # Route53
        response = route53_client.change_resource_record_sets(
            HostedZoneId = route53zoneID,
            ChangeBatch={
                'Changes': [
                    {
                        'Action': 'UPSERT',
                        'ResourceRecordSet': {
                            'Name': validation_record['Name'],
                            'Type': validation_record['Type'],
                            'TTL': 300,
                            'ResourceRecords': [{'Value': validation_record['Value']}]
                        }
                    }
                ]
            }
        )
        
        # Cloudflare API URL to create a DNS record
        cloudflare_api_url = f"https://api.cloudflare.com/client/v4/zones/{cloudflare_zone_id}/dns_records"

        # Create the DNS record data payload
        dns_record_data = {
            "type": validation_record['Type'],
            "name": validation_record['Name'],
            "content": validation_record['Value'],
            "ttl": 300
        }
        
        # Convert the data to JSON format
        json_data = json.dumps(dns_record_data).encode('utf-8')

        # Cloudflare API headers
        headers = {
            "Authorization": f"Bearer {cloudflare_api_key}",
            "Content-Type": "application/json"
        }
    
        # Send a request to Cloudflare API to create the DNS record
        req = urllib.request.Request(cloudflare_api_url, data=json_data, headers=headers)
        
        # Send the request and get the response
        with urllib.request.urlopen(req) as response:
            status_code = response.getcode()
            response_data = response.read().decode('utf-8')
            response_json = json.loads(response_data)

            if status_code == 200:
                # Update DynamoDB with success status
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
                        ':n': 'Create Validation Record in Cloudflare',
                        ':s': 'SUCCEEDED',
                        ':t': int(time.time())
                    }
                )
                return {
                    'status': 'success',
                    'message': 'ACM certificate Validation record created successfully in Cloudflare'
                }
            else:
                raise Exception(f'Failed to create ACM certificate validation record in Cloudflare, Status code: {status_code}')

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
                    ':n': 'Create Validation Record in Cloudflare',
                    ':s': 'FAILED',
                    ':e': str(e),
                    ':t': int(time.time())
                }
            )
        except Exception as ddb_error:
            error_message += f" Additionally, failed to update DynamoDB: {str(ddb_error)}"
        
        raise Exception(f'Error occurred: {error_message}')

