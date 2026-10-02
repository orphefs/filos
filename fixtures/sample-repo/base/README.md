# @acme/ledger

Money, invoices and VAT for Acme's billing services.

- `Money` holds integer cents and a currency, so arithmetic never drifts.
- `roundToCents` is the one place where fractional cents become whole ones.
- `Invoice` totals its lines and adds VAT per country (`computeVat`).
- `createInvoiceHandler` serves `POST /invoices` for the apps.

## Development

    npm install
    npm test

Everything exported from `src/index.ts` is public API and follows semver:
a change to what an exported function returns is a breaking change.
