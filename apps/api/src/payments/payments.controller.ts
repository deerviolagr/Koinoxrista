import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { routes } from '../security/throttle.config';
import { WebhookDto } from './dto/webhook.dto';
import { PaymentsService } from './payments.service';

interface RawBodyRequest {
  rawBody?: Buffer | string;
  headers?: Record<string, string | string[] | undefined>;
}

@Controller()
@UsePipes(new ValidationPipe({ whitelist: true }))
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('invoices/:id/pay')
  @Roles(Role.RESIDENT, Role.ADMIN, Role.BUILDING_OWNER)
  pay(@Param('id') invoiceId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.startCheckout(invoiceId, user);
  }

  @Get('payments/orders/:orderId')
  @Roles(Role.RESIDENT, Role.ADMIN, Role.BUILDING_OWNER)
  order(
    @Param('orderId') orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentsService.getOrder(orderId, user);
  }

  @Get('invoices/:id')
  @Roles(Role.ADMIN, Role.BUILDING_OWNER, Role.RESIDENT)
  invoiceDetail(
    @Param('id') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentsService.getInvoiceDetail(invoiceId, user);
  }
}

/** Viva PSP callback route — intentionally public (no JwtAuthGuard). */
@Controller()
@UsePipes(new ValidationPipe({ whitelist: true }))
export class PaymentsWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('payments/webhook')
  webhook(@Body() dto: WebhookDto) {
    return this.paymentsService.handleWebhook(dto);
  }
}

/**
 * Stripe callback route. The raw request bytes are mandatory: parsing JSON
 * first and then attempting to verify it would allow a body/signature
 * mismatch. The application bootstrap enables Express rawBody capture.
 */
@Controller('payments/webhook/stripe')
@UsePipes(new ValidationPipe({ whitelist: true }))
export class StripeWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @Throttle({ default: { limit: routes.webhook.limit, ttl: routes.webhook.ttlMs } })
  webhook(
    @Req() req: RawBodyRequest,
    @Headers('stripe-signature') signature?: string | string[],
  ) {
    const requestSignature = req?.headers?.['stripe-signature'];
    const signatureHeader = Array.isArray(signature)
      ? signature[0]
      : signature ?? (Array.isArray(requestSignature) ? requestSignature[0] : requestSignature);
    return this.paymentsService.handleStripeWebhook(
      req?.rawBody ?? '',
      signatureHeader ?? '',
    );
  }
}

/** Stripe JP uses the same signed event contract and can share the adapter. */
@Controller('payments/webhook/stripejp')
@UsePipes(new ValidationPipe({ whitelist: true }))
export class StripeJpWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @Throttle({ default: { limit: routes.webhook.limit, ttl: routes.webhook.ttlMs } })
  webhook(
    @Req() req: RawBodyRequest,
    @Headers('stripe-signature') signature?: string | string[],
  ) {
    const requestSignature = req?.headers?.['stripe-signature'];
    const signatureHeader = Array.isArray(signature)
      ? signature[0]
      : signature ?? (Array.isArray(requestSignature) ? requestSignature[0] : requestSignature);
    return this.paymentsService.handleStripeWebhook(
      req?.rawBody ?? '',
      signatureHeader ?? '',
    );
  }
}

/** Mercado Pago callback route — public; verifies server-side before settling. */
@Controller('payments/webhook/mercadopago')
@UsePipes(new ValidationPipe({ whitelist: true }))
export class MercadoPagoWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @Throttle({ default: { limit: routes.webhook.limit, ttl: routes.webhook.ttlMs } })
  webhook(@Body() body: Record<string, unknown>) {
    return this.paymentsService.handleMercadoPagoWebhook({
      type: typeof body.type === 'string' ? body.type : undefined,
      data:
        body.data && typeof body.data === 'object'
          ? { id: (body.data as { id?: unknown }).id as string | undefined }
          : null,
      eventId: typeof body.id === 'string' ? body.id : undefined,
    });
  }
}
