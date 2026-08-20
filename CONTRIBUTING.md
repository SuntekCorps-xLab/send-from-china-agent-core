# Contributing

Thank you for improving the Send From China reference implementation.

## Scope

This repository contains a synthetic, read-only catalog demo and a file-only
ETL example. Do not add production catalog records, customer data, credentials,
private hosts, company integrations, or product images without redistribution
rights.

Open an issue before changing an API shape, security boundary, or the declared
public scope. Provider-specific code must remain behind explicit configuration
and must fail closed when configuration is absent.

## Required Checks

Run the same checks as CI from the repository root:

```bash
cd governance-worker
npm ci
npm run verify
npm audit --audit-level=high
cd ..

python -m py_compile etl-pipeline/scripts/*.py etl-pipeline/tests/*.py
python -m unittest discover -s etl-pipeline/tests -p 'test_*.py'
python etl-pipeline/scripts/validate_import.py \
  --source etl-pipeline/samples/sample_product.json \
  --output build/products.normalized.json \
  --report build/validation-report.json

node scripts/scan-public.mjs .
```

The ETL commands write local files only. They must never make a network call or
publish a product.

## Pull Requests

Describe the user problem, behavioral change, API or configuration impact, and
the exact checks that ran. Keep unrelated changes out of the pull request.

At least one project maintainer must approve a pull request. Security-boundary,
dependency, or release changes require a second review by the repository owner.
See `docs/MAINTAINERS.md` for the responsibility model.

By contributing, you agree that your contribution is licensed under
Apache-2.0, the license used by this project.
