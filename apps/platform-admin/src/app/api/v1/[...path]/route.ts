import { proxyPlatformApi } from '../../../../lib/auth/demo-provider';

export const dynamic = 'force-dynamic';

type RouteContext = { readonly params: { readonly path?: readonly string[] } | Promise<{ readonly path?: readonly string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params;
  const path = params.path?.join('/') ?? '';
  return proxyPlatformApi(request, path);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context);
}
