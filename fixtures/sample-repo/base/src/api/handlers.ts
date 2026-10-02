import { Money, isCurrency } from '../money/money';
import { Invoice } from '../invoice/invoice';
import { isCountry, isVatCategory } from '../tax/vat';

export interface HttpRequest {
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

interface InvoiceBody {
  currency?: unknown;
  country?: unknown;
  lines?: unknown;
}

interface LineBody {
  description?: unknown;
  unitPriceCents?: unknown;
  quantity?: unknown;
  vatCategory?: unknown;
}

/** POST /invoices: builds an invoice from the request body and returns its totals. */
export function createInvoiceHandler(req: HttpRequest): HttpResponse {
  const body = (req.body ?? {}) as InvoiceBody;
  if (!isCurrency(body.currency) || !isCountry(body.country) || !Array.isArray(body.lines)) {
    return badRequest('expected { currency, country, lines[] }');
  }
  const invoice = new Invoice(body.currency, body.country);
  try {
    for (const line of body.lines as LineBody[]) {
      const category = line.vatCategory ?? 'standard';
      if (!isVatCategory(category)) return badRequest(`unknown VAT category "${String(category)}"`);
      invoice.addLine({
        description: String(line.description ?? ''),
        unitPrice: Money.of(Number(line.unitPriceCents), body.currency),
        quantity: Number(line.quantity),
        vatCategory: category,
      });
    }
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
  return { status: 201, body: invoice.total() };
}

function badRequest(message: string): HttpResponse {
  return { status: 400, body: { error: message } };
}
