import {
  AssetCode,
  Function as Lambda,
  FunctionProps,
  IEventSource,
  LayerVersion,
  LayerVersionProps,
  Runtime
} from '@aws-cdk/aws-lambda';
import { LogGroup, LogGroupProps } from '@aws-cdk/aws-logs';
import { IRole, Role, Policy, PolicyStatement, Effect, ServicePrincipal } from '@aws-cdk/aws-iam';
import { BaseConstruct, BaseConstructProps } from './BaseConstruct';
import { Construct, RemovalPolicy } from '@aws-cdk/core';
import { Tables } from './Tables';
import { toKebab, toPascal, toUpperSnake } from '../../lib/changeCase';
import { ApiConfig, ApiEvent, isApiEvent } from './Api';

interface TableDetail {
  tableName: string;
  read?: boolean;
  write?: boolean;
}

type LambdaLayer = string | LayerVersionProps;
export interface LambdaProps
  extends Omit<FunctionProps, 'code' | 'runtime' | 'events' | 'layers'>,
    LogGroupProps {
  functionName: string;
  policyStatements?: PolicyStatement[];
  tables?: (string | TableDetail)[];
  codePath?: string;
  layers?: LambdaLayer[];
  runtime?: FunctionProps['runtime'];
  canInvoke?: IRole[];
  events?: (ApiEvent | IEventSource)[];
}
const omittedLambdaProps = [
  'functionName',
  'logGroupName',
  'description',
  'tables',
  'handler'
] as const;
type OmittedLambdaProps = typeof omittedLambdaProps[number];
export interface LambdasProps extends BaseConstructProps, Omit<LambdaProps, OmittedLambdaProps> {
  lambdas: LambdaProps[];
  tables?: Tables;
}
export interface ResourceGroup {
  lambda: Lambda;
  logGroup: LogGroup;
  role: IRole;
}

export class Lambdas extends BaseConstruct {
  public resources: { [functionName: string]: ResourceGroup } = {};
  public apiConfig?: { [functionName: string]: ApiConfig };
  private tables?: Tables['tables'];
  private code?: AssetCode;
  private layers?: LayerVersion[];

  constructor(scope: Construct, id: string, private props: LambdasProps) {
    super(scope, id, props);
    this.tables = props.tables?.tables;
    if (props.codePath) {
      this.code = new AssetCode(props.codePath);
    }
    if (props.layers?.length) {
      this.layers = props.layers.map(this.mapToLayerVersion);
    }
    for (const lambda of props.lambdas) {
      this.buildResources(lambda);
    }
  }

  buildResources(props: LambdaProps) {
    const functionName = `${this.prefix}-${props.functionName}`.substr(0, 64);
    const removalPolicy = props.removalPolicy ?? this.props.removalPolicy;
    const logGroup = new LogGroup(
      this,
      `${toPascal(props.logGroupName ?? props.functionName)}LogGroup`,
      {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: props.retention ?? this.props.retention,
        encryptionKey: props.encryptionKey ?? this.props.encryptionKey,
        /* eslint-disable indent */
        removalPolicy: removalPolicy
          ? removalPolicy
          : this.prod
          ? RemovalPolicy.RETAIN
          : RemovalPolicy.DESTROY
        /* eslint-enable indent */
      }
    );

    const role = this.buildIam({
      role: props.role ?? this.props.role,
      props,
      logGroup,
      functionName
    });

    const code = props.codePath ? new AssetCode(props.codePath) : this.code;
    if (!code) {
      throw new Error(`no code provided for ${props.functionName}`);
    }
    const runtime = props.runtime ?? this.props.runtime ?? Runtime.NODEJS_14_X;
    const lambda = new Lambda(this, `${toPascal(props.functionName)}Lambda`, {
      ...this.props,
      ...props,
      runtime,
      code,
      role,
      functionName,
      events: undefined,
      layers: undefined
    });

    const layers = props.layers?.map(this.mapToLayerVersion) ?? this.layers ?? [];
    for (const layer of layers) {
      lambda.addLayers(layer);
    }

    lambda.node.addDependency(role);

    if (props.tables?.length) {
      if (!this.tables) {
        throw new Error('no Tables passed to Lambdas');
      }
      for (const nameOrDetail of props.tables) {
        const name = typeof nameOrDetail === 'string' ? nameOrDetail : nameOrDetail.tableName;
        if (!this.tables[name]) {
          throw new Error(
            `failed adding table privileges for function ${props.functionName}.\ntable ${name} doesn't exist`
          );
        }

        /* eslint-disable indent */
        props.tables.length === 1
          ? lambda.addEnvironment('TABLE_NAME', this.tables[name].tableName)
          : lambda.addEnvironment(
              `${toUpperSnake(this.tables[name].tableName)}_TABLE_NAME`,
              this.tables[name].tableName
            );
        /* eslint-enable indent */

        if (typeof nameOrDetail === 'string') {
          this.tables[name].grantReadWriteData(lambda);
          continue;
        }
        const { read, write } = nameOrDetail;
        if (read) {
          this.tables[name].grantReadData(lambda);
        }
        if (write) {
          this.tables[name].grantWriteData(lambda);
        }
      }
    }

    if (props.events?.length) {
      for (const event of props.events) {
        if (isApiEvent(event)) {
          if (!this.apiConfig) {
            this.apiConfig = {};
          }
          this.apiConfig[props.functionName] = {
            lambda,
            method: event.method,
            path: event.path
          };
          continue;
        }
        lambda.addEventSource(event);
      }
    }

    const canInvoke = [...(props.canInvoke || []), ...(this.props.canInvoke || [])];
    if (canInvoke.length) {
      for (const invokeRole of canInvoke) {
        invokeRole.attachInlinePolicy(
          new Policy(this, toPascal(`${invokeRole.roleName}-${props.functionName}`), {
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['lambda:InvokeFunction'],
                resources: [lambda.functionArn]
              })
            ]
          })
        );
      }
    }

    this.resources[props.functionName] = {
      lambda,
      logGroup,
      role
    };
  }

  buildIam({
    functionName,
    logGroup,
    props,
    role
  }: {
    role?: IRole;
    functionName: string;
    logGroup: LogGroup;
    props: LambdaProps;
  }): IRole {
    const truncatedName = functionName.substr(0, 64);
    const _role =
      role ??
      new Role(this, `${toPascal(props.functionName)}Role`, {
        roleName: truncatedName,
        assumedBy: new ServicePrincipal('lambda.amazonaws.com')
      });

    logGroup.grantWrite(_role);

    if (props.policyStatements?.length) {
      props.policyStatements.forEach(statement => _role.addToPrincipalPolicy(statement));
    }

    if (props.vpc) {
      _role.addToPrincipalPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DeleteNetworkInterface',
            'ec2:AssignPrivateIpAddresses',
            'ec2:UnassignPrivateIpAddresses'
          ],
          resources: ['*']
        })
      );
    }

    return _role;
  }

  private mapToLayerVersion = (layer: LambdaLayer, index: number) => {
    const id = `${toPascal(this.prefix)}Layer${index}`;
    const layerProps: LayerVersionProps =
      typeof layer === 'string'
        ? { layerVersionName: toKebab(id), code: new AssetCode(layer) }
        : layer;
    return new LayerVersion(this, id, layerProps);
  };
}
