import { CloudFrontWebDistribution } from '@aws-cdk/aws-cloudfront';
import { IBucket } from '@aws-cdk/aws-s3';
import { StackProps, Stack, Construct } from '@aws-cdk/core';
import { CDNConstruct, CDNConstructProps } from './CDNConstruct';

export interface CDNStackProps extends StackProps, CDNConstructProps {}

export class CDNStack extends Stack {
  public urls?: string[];
  public bucket: IBucket;
  public distribution: CloudFrontWebDistribution;
  constructor(scope: Construct, id: string, props: CDNStackProps) {
    super(scope, id, { ...props, stackName: props.stackName ?? `${props.prefix}-frontend` });
    const { bucket, distribution, urls } = new CDNConstruct(this, 'CDNConstruct', props);
    this.urls = urls;
    this.bucket = bucket;
    this.distribution = distribution;
  }
}
