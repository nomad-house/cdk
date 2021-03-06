import { Construct, Environment } from '@aws-cdk/core';
import { BaseStackProps } from '../stacks/BaseStack';
import { CDNStack, CDNStackProps } from '../stacks/cdn/CDNStack';
import { CognitoStack, CognitoStackProps } from '../stacks/cognito/CognitoStack';
import { CoreStack, CoreStackProps } from '../stacks/core/CoreStack';
import { ServerlessStackProps, ServerlessStack } from '../stacks/serverless/ServerlessStack';
import { getCertArnForDomain } from '../../lib/aws/certificateManager';
import { getHostedZoneIdForDomain } from '../../lib/aws/route53';
import { CDNConstruct } from '../stacks/cdn/CDNConstruct';
import { bucketExists } from '../../lib/aws/s3';
import { listTableNames } from '../../lib/aws/dynamodb';
import { BaseConstruct } from '../constructs/BaseConstruct';
import { existingLogGroups } from '../../lib/aws/cwLogs';

export interface FullStackProps extends BaseStackProps {
  env: Required<Environment>;
  stage: string;
  profile?: string;
  devPort?: number | string;
  rootDomain: string;
  core?: Omit<CoreStackProps, 'prefix' | 'env' | 'rootDomain'>;
  frontend: Omit<
    CDNStackProps,
    'prefix' | 'env' | 'stage' | 'rootDomain' | 'certificate' | 'hostedZone'
  >;
  backend: Omit<ServerlessStackProps, 'cors' | 'prefix' | 'auth' | 'frontend' | 'env'> & {
    cors?: Partial<ServerlessStackProps['cors']>;
  };
  auth?: Omit<CognitoStackProps, 'prefix' | 'env'> & {
    loginCallbackPath?: string;
    logoutCallbackPath?: string;
  };
}

export class FullStack extends BaseConstruct {
  public core: CoreStack;
  public frontend: CDNStack;
  public auth: CognitoStack;
  public backend: ServerlessStack;

  constructor(scope: Construct, id: string, props: FullStackProps) {
    super(scope, id, props);
    const {
      env,
      stage,
      devPort,
      rootDomain,
      core: coreProps,
      auth: authProps,
      frontend: frontendProps,
      backend: backendProps
    } = props;

    this.core = new CoreStack(this, 'Core', {
      ...coreProps,
      env,
      rootDomain,
      prefix: this.prefix
    });

    this.frontend = new CDNStack(this, 'Frontend', {
      ...frontendProps,
      env,
      prefix: this.prefix,
      stage,
      certificate: this.core.certificate,
      hostedZone: this.core.hostedZone,
      rootDomain
    });

    const devAddress = `http://localhost:${devPort ?? 4200}`;
    const urls = (this.frontend.urls ?? []).map(url => `https://${url}`).concat(devAddress);
    this.auth = new CognitoStack(this, 'Auth', {
      ...authProps,
      env,
      prefix: this.prefix,
      groups: authProps?.groups ?? [
        {
          groupName: 'admin'
        }
      ],
      userPoolClient: {
        ...(authProps?.userPoolClient ?? {}),
        oAuth: {
          ...(authProps?.userPoolClient?.oAuth ?? {}),
          callbackUrls: urls
            .map(url => url + authProps?.loginCallbackPath ?? '')
            .concat(authProps?.userPoolClient?.oAuth?.callbackUrls ?? []),
          logoutUrls: urls
            .map(url => url + authProps?.logoutCallbackPath ?? '')
            .concat(authProps?.userPoolClient?.oAuth?.logoutUrls ?? [])
        }
      }
    });

    this.backend = new ServerlessStack(this, 'Backend', {
      ...backendProps,
      env,
      prefix: this.prefix,
      auth: this.auth,
      frontend: this.frontend,
      cors: {
        ...(backendProps.cors ?? {}),
        allowOrigins: urls.concat(backendProps.cors?.allowOrigins ?? [])
      }
    });
  }

  static async create(scope: Construct, id: string, props: FullStackProps): Promise<FullStack> {
    const core = {
      ...props.core
    } as NonNullable<FullStackProps['core']>;
    core.certificateArn =
      props.core?.certificateArn ??
      (await getCertArnForDomain({
        profile: props.profile,
        domain: props.rootDomain,
        region: props.env.region
      }));

    core.hostedZoneId =
      props.core?.hostedZoneId ??
      (await getHostedZoneIdForDomain({
        profile: props.profile,
        rootDomain: props.rootDomain,
        region: props.env.region
      }));

    const frontend: FullStackProps['frontend'] = {
      ...props.frontend
    };
    const bucketName = CDNConstruct.GET_BUCKET_NAME(props);
    if (await bucketExists({ profile: props.profile, region: props.env.region, bucketName })) {
      frontend.bucketExists = true;
    }

    const backend = {
      ...props.backend,
      existingLogGroups: (await existingLogGroups(props)).concat(
        props.backend.existingLogGroups ?? []
      ),
      existingTables: (await listTableNames(props)).concat(props.backend.existingTables ?? [])
    };

    return new FullStack(scope, 'FullStackConstruct', {
      ...props,
      core,
      frontend,
      backend
    });
  }
}
