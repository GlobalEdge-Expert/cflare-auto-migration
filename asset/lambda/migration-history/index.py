import json
import os
import boto3
from botocore.exceptions import ClientError
from decimal import Decimal
from boto3.dynamodb.conditions import Key, Attr

# Get the DynamoDB table name from environment variables
TABLE_NAME = os.getenv('TABLE_NAME')

# Create a DynamoDB resource
dynamodb = boto3.resource('dynamodb')

# Function to convert Decimal types to int or float for JSON serialization
def decimal_to_num(obj):
    if isinstance(obj, Decimal):
        # Convert to int if there are no decimal places
        if obj % 1 == 0:
            return int(obj)
        else:
            return float(obj)
    raise TypeError("Object of type %s is not JSON serializable" % type(obj))

def lambda_handler(event, context):
    # Create a DynamoDB table object
    table = dynamodb.Table(TABLE_NAME)
    
    # Extract the query string parameters, if present
    query_params = event.get('queryStringParameters') or {}
    migration_id = query_params.get('migration_id', None)

    try:
        if migration_id:
            # Query for specific migration_id if it's provided in the query string
            dns_records_response = table.query(
                KeyConditionExpression=Key('migration_id').eq(migration_id)
            )

            # Return the DNS records for the specific migration_id
            result = {
                'dns_records': dns_records_response['Items']
            }
            
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'DNS records fetched successfully',
                    'data': result
                }, default=decimal_to_num)
            }
        else:
            # Scan all items from the DynamoDB table, filtering start_time > 0
            response = table.scan(
                ProjectionExpression='migration_id, zone_name, start_time',  # Retrieve only required attributes
                FilterExpression=Attr('start_time').gt(0),  # Filter items where start_time > 0
            )

            # Extract the scanned data
            data = response.get('Items', [])
            print(data)

            # Sort the data manually by start_time in descending order
            sorted_data = sorted(data, key=lambda x: x['start_time'], reverse=True)

            # Get the latest migration_id and zone_name
            latest_item = sorted_data[0]
            latest_migration_id = latest_item['migration_id']
            latest_zone_name = latest_item['zone_name']

            # Retrieve all dns_records for the latest migration_id
            dns_records_response = table.query(
                KeyConditionExpression=Key('migration_id').eq(latest_migration_id)
            )

            # Retrieve the list of other migration_ids with their zone_names (excluding the latest one)
            other_migration_ids = [
                {'migration_id': item['migration_id'], 'zone_name': item['zone_name']}
                for item in sorted_data[1:]
            ]

            result = {
                'latest_migration_id': {
                    'migration_id': latest_migration_id,
                    'zone_name': latest_zone_name
                },
                'dns_records': dns_records_response['Items'],
                'other_migration_ids': other_migration_ids
            }

            # Return a successful response
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'Migration history fetched successfully',
                    'data': result
                }, default=decimal_to_num)  # Use the custom converter for Decimal
            }
    
    except ClientError as e:
        # Handle errors related to DynamoDB
        print(f'error: {str(e)}')
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'Error fetching migration history from DynamoDB',
                'error': str(e)
            })
        }
    
    except Exception as e:
        # Handle any other general errors
        print(f'error: {str(e)}')
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'An unexpected error occurred',
                'error': str(e)
            })
        }
