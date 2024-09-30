import json
import boto3

def lambda_handler(event, context):
    acm_client = boto3.client('acm', region_name='us-east-1')
    cert_arn = event['CertificateArn']
    
    cert_details = acm_client.describe_certificate(CertificateArn=cert_arn)
    status = cert_details['Certificate']['DomainValidationOptions'][0]['ValidationStatus']
    
    return {
        'ValidationStatus': status
    }
