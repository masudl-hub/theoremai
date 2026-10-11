import type {
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
  ResolvedProviderModel,
} from '../../mod.ts';

class PrototypeContinuation<C, O, S> {
  constructor(
    private readonly original: NonNullable<ProviderAdapter<C, O, unknown, S>['continuation']>,
  ) {}

  get version() {
    return this.original.version;
  }

  get schema() {
    return this.original.schema;
  }

  compatibilityKey(model: ResolvedProviderModel<C, O>) {
    return this.original.compatibilityKey(model);
  }
}

export class PrototypeAdapter<C, O, K, S> implements ProviderAdapter<C, O, K, S> {
  readonly apiVersion = 1;
  readonly continuation?: ProviderAdapter<C, O, K, S>['continuation'];

  constructor(private readonly original: ProviderAdapter<C, O, K, S>) {
    if (original.continuation) this.continuation = new PrototypeContinuation(original.continuation);
  }

  get id() {
    return this.original.id;
  }

  get connectionSchema() {
    return this.original.connectionSchema;
  }

  get optionsSchema() {
    return this.original.optionsSchema;
  }

  get credentialSchema() {
    return this.original.credentialSchema;
  }

  capabilities(model: ResolvedProviderModel<C, O>) {
    return this.original.capabilities(model);
  }

  validateRequest(request: ProviderRequest, model: ResolvedProviderModel<C, O>) {
    this.original.validateRequest(request, model);
  }

  create(context: ProviderContext<C, O, K>) {
    return this.original.create(context);
  }
}
