import json
import boto3
import urllib.parse
import urllib.request
import time
import os
import uuid
from botocore.exceptions import ClientError

def create_route53_hosted_zone(route53_client, zone_name):
    caller_reference = str(time.time())
    try:
        create_zone_response = route53_client.create_hosted_zone(
            Name=zone_name,
            CallerReference=caller_reference,
            HostedZoneConfig={
                'Comment': 'Hosted zone created by Lambda',
                'PrivateZone': False
            }
        )
        return create_zone_response['HostedZone']['Id']
    except ClientError as e:
        print(f"Error creating Route53 hosted zone: {e}")
        return None

def import_dns_records_to_route53(route53_client, aws_zone_id, dns_records):
    changes = [
        {
            'Action': 'CREATE',
            'ResourceRecordSet': {
                'Name': record['name'],
                'Type': record['type'],
                'TTL': record['ttl'],
                'ResourceRecords': [{'Value': record['content']}]
            }
        }
        for record in dns_records
    ]

    if changes:
        try:
            return route53_client.change_resource_record_sets(
                HostedZoneId=aws_zone_id,
                ChangeBatch={'Changes': changes}
            )
        except ClientError as e:
            print(f"Error importing DNS records to Route53: {e}")
            return None
    return None

def fetch_cloudflare_dns_records(api_token, cloudflare_zone_id):
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json"
    }
    dns_records_url = f"https://api.cloudflare.com/client/v4/zones/{cloudflare_zone_id}/dns_records"
    
    try:
        request = urllib.request.Request(dns_records_url, headers=headers)
        with urllib.request.urlopen(request) as response:
            if response.status == 200:
                dns_records_data = json.loads(response.read().decode('utf-8'))
                return dns_records_data["result"]
    except Exception as e:
        print(f"Failed to fetch DNS records from Cloudflare: {e}")
    return None

def start_step_function(step_functions_client, input_data, step_function_arn):
    try:
        response = step_functions_client.start_execution(
            stateMachineArn=step_function_arn,
            input=json.dumps(input_data)
        )
        return response['executionArn']
    except ClientError as e:
        print(f"Error starting Step Function: {e}")
        return None

def start_put_ddb_item(ddb_table, zone_name, migration_id, dns_record, execution_arn, start_time):
    try:
        ddb_table.put_item(
            Item={
                'migration_id': migration_id,
                'zone_name': zone_name,
                'dns_record': dns_record,
                'status': 'STARTED',
                'time': start_time,
                'start_time': start_time,
                'execution_arn': execution_arn,
                'error_message': ''
            }
        )
        print(f"Successfully added item to DynamoDB for {dns_record}")
        return True
    except ClientError as e:
        print(f"Error adding item to DynamoDB for {dns_record}: {e}")
        return False

def lambda_handler(event, context):
    state_machine_arn = os.environ.get('STEP_FUNCTION_ARN')
    ddb_table_name = os.environ.get('TABLE_NAME')
    
    try:
        body = json.loads(event.get('body', '{}'))
        api_token = body.get('apiKey')
        cloudflare_zone_id = body.get('zoneId')

        if not api_token or not cloudflare_zone_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'apiKey and zoneId are required'})
            }
        
        session = boto3.Session()
        route53_client = session.client('route53')
        step_functions_client = session.client('stepfunctions')
        dynamodb = session.resource('dynamodb')
        ddb_table = dynamodb.Table(ddb_table_name)

        dns_records = fetch_cloudflare_dns_records(api_token, cloudflare_zone_id)
        if not dns_records:
            return {
                'statusCode': 500,
                'body': json.dumps({'error': 'Failed to fetch DNS records from Cloudflare.'})
            }

        zone_name = dns_records[0]["zone_name"]
        aws_zone_id = create_route53_hosted_zone(route53_client, zone_name)
        if not aws_zone_id:
            return {
                'statusCode': 500,
                'body': json.dumps({'error': 'Failed to create AWS Hosted Zone.'})
            }

        change_response = import_dns_records_to_route53(route53_client, aws_zone_id, dns_records)
        if not change_response:
            return {
                'statusCode': 500,
                'body': json.dumps({'error': 'Failed to import DNS records to Route 53.'})
            }

        proxied_records = [record for record in dns_records if record.get('proxied')]
        migration_id = str(uuid.uuid4())
        execution_arns = []

        first_iteration = True
        for record in proxied_records:
            input_data = {
                "viewer_domain": record["name"],
                "migration_id": migration_id,
                "origin_info": {
                    "type": record["type"],
                    "value": record["content"]
                },
                "ZoneID": aws_zone_id,
                "CloudflareZoneID": cloudflare_zone_id,
                "CloudflareAPIKey": api_token
            }
            
            execution_arn = start_step_function(step_functions_client, input_data, state_machine_arn)
            if execution_arn:
                if first_iteration:
                    start_time = int(time.time())
                    first_iteration = False
                else:
                    start_time = 0
                
                if start_put_ddb_item(ddb_table, zone_name, migration_id, record["name"], execution_arn, start_time):
                    execution_arns.append(execution_arn)
                else:
                    print(f"Failed to add item to DynamoDB for {record['name']}")
            break

        if execution_arns:
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'DNS records imported and Step Functions started successfully',
                    'executionArns': execution_arns
                })
            }
        else:
            return {
                'statusCode': 500,
                'body': json.dumps({'error': 'Failed to start Step Functions or add items to DynamoDB.'})
            }

    except Exception as e:
        print(f"Unexpected error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }