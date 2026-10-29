# Ledger API

FastAPI service. Deploy with `make deploy`; run tests with `pytest -x`.

## Getting started

FastAPI is a modern web framework. To start, install Python 3.12, create a virtualenv with `python -m venv .venv`, activate it, run `pip install -r requirements.txt`, then start the server with `uvicorn app.main:app --reload`. Open http://localhost:8000/docs to see the interactive API documentation. From there you can try each endpoint, read the request and response schemas, and copy example curl commands.

## Style

Follow PEP 8. Use 4 spaces for indentation and snake_case for functions and variables. Keep lines under 88 characters.

## Testing

Run `pytest -x` before opening a PR. Run tests thoroughly and never skip them. Integration tests need `DATABASE_URL`; without it they are skipped.

## Deployment

`make deploy` builds the image and pushes it. Do not run it from a feature branch, because production deploys must come from `main`.
