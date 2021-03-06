import { CloudFrontWebDistribution } from '@aws-cdk/aws-cloudfront';
import { IBucket } from '@aws-cdk/aws-s3';
import { NestedStackProps, NestedStack, Construct } from '@aws-cdk/core';
import { CDNConstruct, CDNConstructProps } from './CDNConstruct';

export interface CDNNestedStackProps extends NestedStackProps, CDNConstructProps {}

export class CDNNestedStack extends NestedStack {
  public urls?: string[];
  public bucket: IBucket;
  public distribution: CloudFrontWebDistribution;
  constructor(scope: Construct, id: string, props: CDNNestedStackProps) {
    super(scope, id, props);
    const { bucket, distribution, urls } = new CDNConstruct(this, 'CDNConstruct', props);
    this.urls = urls;
    this.bucket = bucket;
    this.distribution = distribution;
  }
}
