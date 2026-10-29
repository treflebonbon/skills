# Acme Storefront

Next.js storefront on Postgres. CRITICAL: NEVER edit anything under `generated/`; it is overwritten by `pnpm gen`.

## Overview

This project is a web application for selling products online. Write clean code and follow best practices.

## Tools

Only use tools when strictly necessary. Minimize tool calls.

## Working style

Do not be lazy. Be thorough. NEVER give up. CRITICAL: ALWAYS double check everything you do before answering.

## API reference

| Endpoint            | Method | Description        |
| ------------------- | ------ | ------------------ |
| /api/products       | GET    | List products      |
| /api/products/:id   | GET    | Get one product    |
| /api/products       | POST   | Create a product   |
| /api/orders         | GET    | List orders        |
| /api/orders/:id     | GET    | Get one order      |
| /api/orders         | POST   | Create an order    |
| /api/cart           | GET    | Get the cart       |
| /api/cart/items     | POST   | Add a cart item    |
| /api/cart/items/:id | DELETE | Remove a cart item |
| /api/users/me       | GET    | Current user       |

## Commands

- `pnpm test` runs unit tests; `pnpm test path/to/file.test.ts` runs one file.
- `pnpm lint` and `pnpm typecheck` must pass before a PR.

## Architecture decisions

We keep pricing rules in `src/domain/pricing` and never import them from `src/ui`, because pricing must stay testable without React. Longer rationale lives in the ADRs.
