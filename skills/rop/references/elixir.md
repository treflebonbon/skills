# Elixir ROP Patterns

## bind — `with` Statement

`with` is Elixir's primary bind. Each clause pattern-matches on `{:ok, value}` and short-circuits on mismatch.

```elixir
def create_order(params) do
  with {:ok, validated} <- validate(params),
       {:ok, user} <- fetch_user(validated.user_id),
       {:ok, order} <- build_order(user, validated),
       {:ok, saved} <- Repo.insert(order) do
    {:ok, saved}
  end
end
```

### `with` + `else` for Error Mapping

Map errors to domain types at the boundary:

```elixir
def create_order(params) do
  with {:ok, validated} <- validate(params),
       {:ok, user} <- fetch_user(validated.user_id),
       {:ok, order} <- Repo.insert(build_order(user, validated)) do
    {:ok, order}
  else
    {:error, %Ecto.Changeset{} = cs} -> {:error, Error.from_changeset(cs)}
    {:error, :not_found} -> {:error, Error.not_found("user", params.user_id)}
  end
end
```

## tee — Side Effects

Stay on the two-track with `tap_ok` (defined in Pipeline Composition below):

```elixir
create_order(params)
|> tap_ok(fn order -> Logger.info("Order created: #{order.id}") end)
|> tap_ok(fn _order -> Metrics.increment("orders.created") end)
```

For fallible side effects, chain with `with`:

```elixir
with {:ok, order} <- create_order(params),
     {:ok, _} <- send_confirmation(order),
     {:ok, _} <- audit_log(:order_created, order) do
  {:ok, order}
end
```

## tryCatch — Exception Boundary

Wrap external calls that raise exceptions:

```elixir
defp safe_http_get(url) do
  case Req.get(url) do
    {:ok, %Req.Response{status: 200, body: body}} -> {:ok, body}
    {:ok, %Req.Response{status: status}} -> {:error, Error.http(status)}
    {:error, %Req.TransportError{reason: reason}} -> {:error, Error.network(reason)}
    {:error, exception} -> {:error, Error.unexpected(exception)}
  end
rescue
  e -> {:error, Error.unexpected(e)}
end
```

Rule: `rescue` only at system boundaries. Never in business logic.

## plus — Parallel Validation

Accumulate independent validation errors:

```elixir
def validate(params) do
  [
    validate_name(params),
    validate_email(params),
    validate_age(params)
  ]
  |> collect_results()
end

defp collect_results(results) do
  {oks, errors} = Enum.split_with(results, &match?({:ok, _}, &1))

  case errors do
    [] -> {:ok, Enum.map(oks, fn {:ok, v} -> v end)}
    errs -> {:error, Enum.map(errs, fn {:error, e} -> e end)}
  end
end
```

## Pipeline Composition with `|>`

For reusable composed pipelines:

```elixir
def process(input) do
  input
  |> validate()
  |> map_ok(&canonicalize/1)
  |> bind_ok(&persist/1)
  |> tap_ok(&notify/1)
end

defp bind_ok({:ok, value}, func), do: func.(value)
defp bind_ok({:error, _} = err, _func), do: err

defp map_ok({:ok, value}, func), do: {:ok, func.(value)}
defp map_ok({:error, _} = err, _func), do: err

defp tap_ok({:ok, value} = result, func) do
  func.(value)
  result
end
defp tap_ok({:error, _} = err, _func), do: err
```

## Gotchas

- **`with` の `else` 節**: `else` を省略すると、マッチしない値がそのまま返る。`{:error, %Ecto.Changeset{}}` 等の内部型がリークしやすい — boundary では必ず `else` でドメインエラーに変換
- **bare `=` in `with`**: `with` 内の `=` は二本レール短絡に参加しない。`Credo.Check.Refactor.WithClauses` が先頭/末尾の `=` を警告する
- **`rescue` のスコープ**: `with` ブロック内で `rescue` は使えない。`rescue` が必要なら別関数に切り出す
