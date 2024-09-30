import boto3

def lambda_handler(event, context):
    # Initialize the CloudFront client
    cloudfront_client = boto3.client('cloudfront')

    # Retrieve the DistributionId from the Step Functions input
    distribution_id = event['DistributionId']

    try:
        # Describe the CloudFront distribution to get its status
        response = cloudfront_client.get_distribution(
            Id=distribution_id
        )

        # Extract the distribution status
        distribution_status = response['Distribution']['Status']

        # Return the result
        return {
            'Status': distribution_status
        }

    except Exception as e:
        # Handle and return any errors that occur
        return {
            'error': str(e)
        }
