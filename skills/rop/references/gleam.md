# Gleam ROP Patterns

## bind — `use` Expression

`use` is syntactic sugar for monadic bind. It desugars to a callback.

```gleam
pub fn create_order(params: OrderParams) -> Result(Order, AppError) {
  use validated <- result.try(validate(params))
  use user <- result.try(fetch_user(validated.user_id))
  use order <- result.try(save_order(build_order(user, validated)))
  Ok(order)
}
```

Desugars to:

```gleam
pub fn create_order(params: OrderParams) -> Result(Order, AppError) {
  result.try(validate(params), fn(validated) {
    result.try(fetch_user(validated.user_id), fn(user) {
      result.try(save_order(build_order(user, validated)), fn(order) {
        Ok(order)
      })
    })
  })
}
```

## map — Pure Transformation

```gleam
pub fn process(id: String) -> Result(String, AppError) {
  fetch_user(id)
  |> result.map(fn(user) { string.lowercase(user.email) })
}
```

Inside a `use` chain, just call the pure function directly:

```gleam
pub fn process(id: String) -> Result(String, AppError) {
  use user <- result.try(fetch_user(id))
  let email = string.lowercase(user.email)
  Ok(email)
}
```

## tee — Side Effects

Gleam stdlib doesn't have `result.tap`. Define it or use inline:

```gleam
// Custom tap — operates on Result, stays on the two-track
pub fn tap(
  over result: Result(a, e),
  with func: fn(a) -> Nil,
) -> Result(a, e) {
  case result {
    Ok(value) -> {
      func(value)
      Ok(value)
    }
    Error(e) -> Error(e)
  }
}
```

Usage in a pipeline (stays on the two-track):

```gleam
pub fn process(params) {
  create_order(params)
  |> tap(fn(o) { logger.info("Order created: " <> o.id) })
}
```

For fallible side effects, chain with `use`:

```gleam
pub fn process(params) {
  use order <- result.try(create_order(params))
  use _ <- result.try(send_notification(order))
  use _ <- result.try(audit_log(order))
  Ok(order)
}
```

## plus — Parallel Validation

Accumulate errors with a custom combinator. Use `result.replace` to make heterogeneous results homogeneous for error collection:

```gleam
pub fn validate(params: Params) -> Result(ValidatedParams, List(AppError)) {
  let name_result = validate_name(params)
  let email_result = validate_email(params)
  let age_result = validate_age(params)

  let errors = collect_errors([
    name_result |> result.replace(Nil),
    email_result |> result.replace(Nil),
    age_result |> result.replace(Nil),
  ])

  case errors {
    [] -> {
      let assert Ok(name) = name_result
      let assert Ok(email) = email_result
      let assert Ok(age) = age_result
      Ok(ValidatedParams(name:, email:, age:))
    }
    errs -> Error(errs)
  }
}

fn collect_errors(results: List(Result(Nil, AppError))) -> List(AppError) {
  list.filter_map(results, fn(r) {
    case r {
      Error(e) -> Ok(e)
      Ok(_) -> Error(Nil)
    }
  })
}
```

## Pipeline Composition with `|>`

```gleam
pub fn process(input) {
  input
  |> validate()
  |> result.try(canonicalize)
  |> result.try(persist)
  |> result.map(to_response)
}
```

## Gotchas

- **`result.tap` は stdlib にない**: Gleam は 1.0 を超えて安定運用されているが、現行の `gleam_stdlib` でも `gleam/result` と `gleam/function` のいずれにも `tap` は実装されていない。カスタム定義が必要（上記 tee セクション参照）
- **`use` のスコープ**: `use` は残りの関数本体全体をコールバックに変換する。早期リターンの意味ではなく、continuation passing style
- **Error 型の統一**: `Result(a, ErrorA)` と `Result(b, ErrorB)` を `use` で連鎖するには共通のエラー型（union type）が必要。Gleam に自動エラー合成はない
