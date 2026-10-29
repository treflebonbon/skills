# Rust ROP Patterns

## bind — `?` Operator and `and_then`

`?` is syntactic sugar for early return on `Err`. It is the primary bind mechanism.

```rust
fn create_order(params: &OrderParams) -> Result<Order, AppError> {
    let validated = validate(params)?;
    let user = fetch_user(&validated.user_id)?;
    let order = build_order(&user, &validated);
    let saved = repo.insert(&order)?;
    Ok(saved)
}
```

`and_then` for functional composition:

```rust
fn process(input: Input) -> Result<Output, AppError> {
    validate(input)
        .and_then(|v| canonicalize(v))
        .and_then(|c| persist(c))
}
```

### `?` with `From` trait for error conversion

`#[from]` in `thiserror` auto-generates `From` impls. The `?` operator uses `From` to convert errors:

```rust
// #[from] on Database variant already generates From<sqlx::Error>
// No manual impl needed — just use ?

async fn fetch_user(pool: &PgPool, id: &str) -> Result<User, AppError> {
    let user = sqlx::query_as!(User, "SELECT * FROM users WHERE id = $1", id)
        .fetch_one(pool)
        .await?;  // sqlx::Error → AppError via #[from]
    Ok(user)
}
```

## map — Pure Transformation

```rust
fn process(id: &str) -> Result<String, AppError> {
    fetch_user(id)
        .map(|user| user.email.to_lowercase())
}
```

Inside `?` chains, just call the function:

```rust
fn process(id: &str) -> Result<String, AppError> {
    let user = fetch_user(id)?;
    let email = user.email.to_lowercase();  // pure transform, no ?
    Ok(email)
}
```

## tee — Side Effects

Use `inspect` (stable since Rust 1.76) or a custom tap:

```rust
fn process(params: &Params) -> Result<Order, AppError> {
    create_order(params)
        .inspect(|order| tracing::info!("Order created: {}", order.id))
        .inspect_err(|e| tracing::error!("Order failed: {}", e))
}
```

For fallible side effects, use `?` in sequence:

```rust
fn process(params: &Params) -> Result<Order, AppError> {
    let order = create_order(params)?;
    send_notification(&order)?;
    audit_log(&order)?;
    Ok(order)
}
```

## doubleMap — Both Tracks

```rust
fn process(input: Input) -> Result<ApiResponse, ApiError> {
    validate(input)
        .map(|v| to_response(v))
        .map_err(|e| to_api_error(e))
}
```

## plus — Parallel Validation

Accumulate errors with a custom combinator:

```rust
fn validate(params: &Params) -> Result<ValidatedParams, Vec<AppError>> {
    let results = vec![
        validate_name(params),
        validate_email(params),
        validate_age(params),
    ];

    let errors: Vec<AppError> = results
        .into_iter()
        .filter_map(|r| r.err())
        .collect();

    if errors.is_empty() {
        Ok(ValidatedParams::from(params))
    } else {
        Err(errors)
    }
}
```

Or with the `garde` / `validator` crate for declarative validation.

## Pipeline Composition

```rust
// Functional style
fn process(input: Input) -> Result<Output, AppError> {
    validate(input)
        .and_then(canonicalize)
        .and_then(persist)
        .map(to_response)
}

// Sequential bind with ? (do-notation style)
fn process(input: Input) -> Result<Output, AppError> {
    let validated = validate(input)?;
    let canonical = canonicalize(validated)?;
    let saved = persist(canonical)?;
    Ok(to_response(saved))
}
```

Both styles are ROP. `?` is syntactic sugar for bind (like Haskell do-notation). Use `?` chains when steps need intermediate bindings. Use `and_then` chains for point-free composition.

## Gotchas

- **`?` と `From` トレイト**: `?` は `From::from()` を暗黙呼び出しする。`#[from]` を付けた variant が2つ以上同じソース型を持つとコンパイルエラー
- **`and_then` vs `?`**: `and_then` は関数合成に適するが、中間バインディングが必要な場合は `?` の方が読みやすい。混在は避ける
- **`catch_unwind` は ROP ではない**: `catch_unwind` はパニックを捕捉するが、Result ベースのエラーハンドリングではない。FFI 境界やスレッドプール等の限定的な用途に留め、通常のエラーハンドリングには使わない
