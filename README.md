# Cloudflare to CloudFront Auto Migration

This repository contains the CDK code required for automatically migrating DNS records from Cloudflare to CloudFront.

## Prerequisites

Before deploying the CloudFront auto-migration solution, ensure the following prerequisites are met:

- **AWS Account**: You need an active AWS account.
- **GitHub Access**: To clone the repository.
- **Cloudflare API Key**: Ensure you have access to the necessary credentials for Cloudflare.

---

## Installation and Deployment Guide

### Step 1: Log into AWS Console (us-east-1)

1. Log into the [AWS Management Console](https://us-east-1.console.aws.amazon.com/console/home?region=us-east-1).
   > **Note**: This deployment must be carried out in the **`us-east-1` region**.
2. In the top navigation bar, click the **CloudShell** icon (or search for **CloudShell** in the AWS services).
3. Once **CloudShell** opens, you will have access to a terminal connected to your AWS environment.

   > **Note**: **AWS CloudShell** comes pre-installed with **Node.js** and **AWS CDK**, so you can proceed directly to cloning the repository.

### Step 2: Clone the Repository

In the AWS CloudShell terminal, clone the GitHub repository:

```bash
git clone https://github.com/GlobalEdge-Expert/cflare-auto-migration.git
```

Navigate into the cloned repository:

```bash
cd cflare-auto-migration
```

### Step 3: Bootstrap the AWS Environment (if required)
Before deploying the CDK stack, you might need to bootstrap your AWS environment if it hasn’t been bootstrapped already. This step prepares the AWS environment for deploying CDK stacks.

To check if your environment is already bootstrapped, attempt to run the cdk deploy command (see Step 4). If the environment isn’t bootstrapped, follow the instructions below.

If your environment has not been bootstrapped yet, run the following command:

```bash
cdk bootstrap aws://ACCOUNT_ID/us-east-1
```
   > **Note**: Replace `ACCOUNT_ID` with your AWS account ID.

If the environment is already bootstrapped, you can skip this step.

### Step 4: Deploy the CDK Stack

```bash
cdk deploy
```

During deployment, you will be prompted to approve the creation of IAM roles and other resources. Type **`y`** and press **Enter** to confirm.

### Step 5: Monitor the Deployment

Once the deployment is complete, you can monitor the resources in the **AWS Management Console**. Check that the necessary resources such as **Lambda functions**, **Step Functions**, and the **CloudFront distribution** have been deployed correctly.

---

## Cleanup

To avoid incurring ongoing charges in your AWS account, make sure to clean up the deployed resources when you are done:

`cdk destroy`

This will delete all AWS resources created by the CDK stack.

---

## License

This project is licensed under the MIT License.

---
