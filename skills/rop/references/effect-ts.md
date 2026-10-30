# Effect-TS ROP Patterns

この reference のコード例は Effect 3 を対象とする。適用前に対象プロジェクトの major version を確認する。Effect 4 では [公式ガイド](https://effect.website/docs/v4/error-management/error-accumulation) で API を照合する。

## bind — `Effect.gen` with `yield*` / `Effect.flatMap`

### Generator style (preferred for multi-step pipelines)

`Effect.gen` is do-notation. `yield*` is bind.

```typescript
const createOrder = (params: OrderParams) =>
  Effect.gen(function* () {
    const validated = yield* validate(params);
    const user = yield* fetchUser(validated.userId);
    const order = buildOrder(user, validated);
    const saved = yield* saveOrder(order);
    return saved;
  });
```

### Pipe style (preferred for linear transformations)

```typescript
const process = (input: Input) =>
  pipe(validate(input), Effect.flatMap(canonicalize), Effect.flatMap(persist));
```

## map — Pure Transformation

```typescript
// Pipe style
const process = (id: string) =>
  pipe(
    fetchUser(id),
    Effect.map((user) => user.email.toLowerCase()),
  );

// Inside gen — just call the function
const process = (id: string) =>
  Effect.gen(function* () {
    const user = yield* fetchUser(id);
    const email = user.email.toLowerCase(); // pure transform, no yield*
    return email;
  });
```

Rule: `yield*` only for Effects. Pure transforms are plain assignments.

## tee — Side Effects

`Effect.tap` runs a side effect and returns the original value:

```typescript
const process = (params: Params) =>
  pipe(
    createOrder(params),
    Effect.tap((order) => logOrderCreated(order)),
    Effect.tap((order) => incrementMetric("orders.created")),
  );
```

For fallible side effects inside gen:

```typescript
const process = (params: Params) =>
  Effect.gen(function* () {
    const order = yield* createOrder(params);
    yield* sendNotification(order);
    yield* auditLog("order_created", order);
    return order;
  });
```

## tryCatch — Exception Boundary

Wrap external APIs that throw:

```typescript
// For sync functions
const safeParse = (json: string) =>
  Effect.try({
    try: () => JSON.parse(json),
    catch: (e) => new ParseError({ cause: e }),
  });

// For async/Promise functions
const safeFetch = (url: string) =>
  Effect.tryPromise({
    try: () => fetch(url).then((r) => r.json()),
    catch: (e) => new NetworkError({ cause: e }),
  });
```

Rule: `Effect.try` / `Effect.tryPromise` only at system boundaries. Internal Effect code should not throw.

## doubleMap — Both Tracks

```typescript
const process = (input: Input) =>
  pipe(validate(input), Effect.map(toResponse), Effect.mapError(toApiError));
```

Or use `Effect.mapBoth` for simultaneous transformation:

```typescript
const process = (input: Input) =>
  pipe(
    validate(input),
    Effect.mapBoth({
      onSuccess: toResponse,
      onFailure: toApiError,
    }),
  );
```

## plus — 検証とエラー集約

```typescript
// Fail-fast (first error stops)
const validate = (params: Params) =>
  Effect.all([validateName(params), validateEmail(params), validateAge(params)]);

// Accumulate all errors
const validate = (params: Params) =>
  Effect.validateAll(
    [validateName(params), validateEmail(params), validateAge(params)],
    (effect) => effect,
  );
```

Effect 3 の `validateAll` は各入力へ適用する関数も受け取る。[公式のエラー集約例](https://effect.website/docs/v3/additional-resources/effect-vs-neverthrow#combinewithallerrors-1)を参照する。並列に実行する必要がある場合は、対象 API の `concurrency` option も明示する。

For struct-style validation:

```typescript
const validate = (params: Params) =>
  Effect.all({
    name: validateName(params),
    email: validateEmail(params),
    age: validateAge(params),
  });
// Result type: Effect<{ name: Name, email: Email, age: Age }, ValidationError>
```

## Pipeline Composition

```typescript
// Pipe style — linear transformations
const process = (input: Input) =>
  pipe(
    validate(input),
    Effect.flatMap(canonicalize),
    Effect.flatMap(persist),
    Effect.map(toResponse),
    Effect.mapError(toApiError),
  );

// Gen style — complex logic with intermediate values
const process = (input: Input) =>
  Effect.gen(function* () {
    const validated = yield* validate(input);
    const canonical = yield* canonicalize(validated);
    const saved = yield* persist(canonical);
    return toResponse(saved);
  });
```

Use pipe for linear chains. Use gen when steps need intermediate bindings or conditional logic.

## Service Pattern (Dependency Injection)

Effect-TS ROP extends to service dependencies via the `R` type parameter:

```typescript
class OrderRepository extends Context.Tag("OrderRepository")<
  OrderRepository,
  { readonly save: (order: Order) => Effect.Effect<Order, DatabaseError> }
>() {}

const createOrder = (params: OrderParams) =>
  Effect.gen(function* () {
    const repo = yield* OrderRepository;
    const validated = yield* validate(params);
    const saved = yield* repo.save(buildOrder(validated));
    return saved;
  });
// Type: Effect<Order, ValidationError | DatabaseError, OrderRepository>
```

The error channel automatically accumulates all possible error types through the pipeline.

## Gotchas

- **`yield*` は Effect 専用**: `yield*` を純粋な値に使うと型エラー。純粋変換は通常の `const x = f(y)` で行う
- **`Effect.all` と `Effect.validateAll`**: `Effect.all` は fail-fast。Effect 3 でエラーを蓄積する検証は `Effect.validateAll(effects, effect => effect)` を使い、並列化する場合は `concurrency` も指定する。
- **Service Pattern の `R` パラメータ**: エラー型 `E` は自動合成されるが、Requirements `R` も自動合成される。`pipe` チェーンの型推論が複雑になる場合は `Effect.gen` を使う
- **`Data.TaggedError` の `_tag`**: `_tag` プロパティで `Effect.catchTag` によるパターンマッチが可能。`Data.TaggedError` を使うと `_tag` が自動設定される — plain class で `catchTag` を使う場合は `_tag` プロパティを手動で定義する必要がある
