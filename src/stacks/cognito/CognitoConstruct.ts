import { Construct, Fn, IResolvable, RemovalPolicy, Stack } from '@aws-cdk/core';
import {
  Role,
  FederatedPrincipal,
  RoleProps,
  PolicyDocument,
  PolicyStatement
} from '@aws-cdk/aws-iam';
import {
  UserPool,
  UserPoolClient,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  CfnUserPoolDomain,
  CfnUserPoolGroup,
  UserPoolClientIdentityProvider,
  CfnUserPoolUICustomizationAttachment,
  CfnIdentityPoolProps,
  UserPoolProps,
  UserPoolClientProps
} from '@aws-cdk/aws-cognito';
import { Mutable } from '../../../lib/Mutable';
import { toKebab, toPascal } from '../../../lib/changeCase';
import { BaseConstruct, BaseConstructProps } from '../../constructs/BaseConstruct';

interface CognitoGroupConfig {
  groupName: string;
  policyStatements?: PolicyStatement[];
}
type IdentityPoolConfig = CfnIdentityPoolProps & { removalPolicy?: RemovalPolicy };

export interface CognitoConstructProps extends BaseConstructProps {
  userPool?: UserPoolProps;
  userPoolClient?: Omit<UserPoolClientProps, 'userPool'>;
  identityPool?: IdentityPoolConfig;
  dns?: {
    certificateArn?: string;
    domain: string;
  };
  policyStatements?: PolicyStatement[];
  groups?: CognitoGroupConfig[];
  css?: string;
  samlAuth?: boolean;
}

export class CognitoConstruct extends BaseConstruct {
  private static DEFAULT_GROUP_NAME = 'authenticated';
  public userPool!: UserPool;
  public userPoolClient!: UserPoolClient;
  public userPoolDomain!: CfnUserPoolDomain;
  public identityPool!: CfnIdentityPool;
  public roles: { [groupName: string]: Role } = {};

  constructor(scope: Construct, id: string, props: CognitoConstructProps) {
    super(scope, id, props);
    this.buildUserPool(props);
    this.buildIdentityPool(props);
    this.buildGroups(props);

    if (props.css) {
      new CfnUserPoolUICustomizationAttachment(this, 'CognitoUICustomization', {
        userPoolId: this.userPool.userPoolId,
        clientId: this.userPoolClient.userPoolClientId,
        css: props.css
      });
    }
  }

  buildUserPool({ prefix, userPool, userPoolClient, samlAuth, dns }: CognitoConstructProps) {
    this.userPool = new UserPool(this, 'UserPool', {
      ...userPool,
      userPoolName: prefix,
      removalPolicy: this.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      selfSignUpEnabled: userPool?.selfSignUpEnabled ?? false,
      autoVerify: userPool?.autoVerify ?? {
        email: true
      },
      standardAttributes: userPool?.standardAttributes ?? {
        email: {
          required: true,
          mutable: samlAuth
        }
      }
    });
    this.userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      ...userPoolClient,
      userPoolClientName: prefix,
      userPool: this.userPool,
      supportedIdentityProviders: userPoolClient?.supportedIdentityProviders ?? [
        UserPoolClientIdentityProvider.COGNITO
      ],
      generateSecret: userPoolClient?.generateSecret ?? false
    });
    this.userPoolDomain = new CfnUserPoolDomain(
      this,
      'UserPoolDomain',
      /* eslint-disable indent */
      dns
        ? {
            userPoolId: this.userPool.userPoolId,
            domain: dns.domain,
            customDomainConfig: dns.certificateArn
              ? { certificateArn: dns.certificateArn }
              : undefined
          }
        : {
            userPoolId: this.userPool.userPoolId,
            domain: prefix
          }
      /* eslint-enable indent */
    );
  }

  buildGroups(props: CognitoConstructProps) {
    const defaultGroup: CognitoGroupConfig = {
      groupName: CognitoConstruct.DEFAULT_GROUP_NAME,
      policyStatements: props.policyStatements
    };
    const hasDefault = !!props.groups?.find(
      ({ groupName }) => groupName === CognitoConstruct.DEFAULT_GROUP_NAME
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const groups = hasDefault ? props.groups! : [defaultGroup, ...(props.groups ?? [])];

    for (const group of groups) {
      const roleProps: Mutable<RoleProps> = {
        roleName: `${this.prefix}-${group.groupName}-group`,
        assumedBy: new FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': this.identityPool.ref
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'authenticated'
            }
          },
          'sts:AssumeRoleWithWebIdentity'
        )
      };
      const policyStatements = [
        ...(group.policyStatements ?? []),
        ...(props.policyStatements ?? [])
      ];
      if (policyStatements?.length) {
        roleProps.inlinePolicies = {
          [`${this.prefix}-${group.groupName}`]: new PolicyDocument({
            statements: policyStatements
          })
        };
      }
      const role = new Role(this, `${toPascal(group.groupName)}GroupRole`, roleProps);
      if (group.groupName !== CognitoConstruct.DEFAULT_GROUP_NAME) {
        new CfnUserPoolGroup(this, `${toPascal(group.groupName)}Group`, {
          groupName: toKebab(group.groupName),
          roleArn: role.roleArn,
          userPoolId: this.userPool.userPoolId
        });
      }
      this.roles[group.groupName] = role;
    }

    new CfnIdentityPoolRoleAttachment(this, 'AuthorizedUserRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.roles[CognitoConstruct.DEFAULT_GROUP_NAME].roleArn
      },
      roleMappings: {
        cognitoProvider: {
          identityProvider: Fn.join('', [
            'cognito-idp.',
            Stack.of(this).region,
            '.amazonaws.com/',
            this.userPool.userPoolId,
            ':',
            this.userPoolClient.userPoolClientId
          ]),
          type: 'Token',
          ambiguousRoleResolution: 'AuthenticatedRole'
        }
      }
    });
  }

  buildIdentityPool({ prefix, identityPool }: CognitoConstructProps) {
    const defaultProvider = {
      serverSideTokenCheck: false,
      clientId: this.userPoolClient.userPoolClientId,
      providerName: this.userPool.userPoolProviderName
    };

    /* eslint-disable indent */
    const cognitoIdentityProviders = Array.isArray(identityPool?.cognitoIdentityProviders)
      ? [
          ...(identityPool as {
            cognitoIdentityProviders: (
              | IResolvable
              | CfnIdentityPool.CognitoIdentityProviderProperty
            )[];
          }).cognitoIdentityProviders,
          defaultProvider
        ]
      : identityPool?.cognitoIdentityProviders
      ? [identityPool?.cognitoIdentityProviders, defaultProvider]
      : [defaultProvider];
    /* eslint-enable indent */

    this.identityPool = new CfnIdentityPool(this, 'IdentityPool', {
      ...(identityPool || []),
      identityPoolName: prefix,
      cognitoIdentityProviders,
      allowUnauthenticatedIdentities: identityPool?.allowUnauthenticatedIdentities ?? false
    });

    if (identityPool?.removalPolicy) {
      this.identityPool.applyRemovalPolicy(identityPool.removalPolicy);
    }
  }
}
