import boto3
import json
import os
import time

def lambda_handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['TABLE_NAME'])

    print(event)

    migration_id = event.get('migration_id')
    dns_record = event.get('viewer_domain')
    step_name = event.get('step_name', 'Unknown step')

    error_type = event.get('error', {}).get('Error', 'UnknownError')
    error_message = event.get('error', {}).get('Cause', 'UnknownCause')

    try:
        cause_details = json.loads(error_message)
        error_message = cause_details.get('errorMessage', 'Unknown error')
    except json.JSONDecodeError:
        pass
        
    combined_error_message = f"error_type: {error_type}, error_message: {error_message}"
    
    try:
        response = table.update_item(
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
                ':n': event.get('step_name', 'Unknown step'),
                ':s': 'FAILED',
                ':e': combined_error_message,
                ':t': int(time.time())
            }
        )
        
        print(f"DynamoDB update successful for migration_id: {migration_id}, dns_record: {dns_record}")
        return {
            'statusCode': 200,
            'body': json.dumps('Error information updated in DynamoDB')
        }
    except Exception as e:
        print(f"Error updating DynamoDB: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps(f'Failed to update error information: {str(e)}')
        }