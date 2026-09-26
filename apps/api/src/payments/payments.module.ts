import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { ArrearsController } from './arrears.controller';
import { ArrearsService } from './arrears.service';
import {
  PaymentsController,
  PaymentsWebhookController,
  StripeWebhookController,
  StripeJpWebhookController,
  MercadoPagoWebhookController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  createVivaAdapter,
  UnavailableVivaAdapter,
  VIVA_ADAPTER,
} from './viva.adapter';
import {
  createStripeJpAdapter,
  STRIPE_JP_ADAPTER,
} from './stripejp.adapter';
import { createStripeAdapter, STRIPE_ADAPTER } from './stripe.adapter';
import {
  createMercadoPagoAdapter,
  MERCADOPAGO_ADAPTER,
  UnavailableMercadoPagoAdapter,
} from './mercadopago.adapter';

@Module({
  imports: [AuditModule],
  controllers: [
    PaymentsController,
    PaymentsWebhookController,
    StripeWebhookController,
    StripeJpWebhookController,
    MercadoPagoWebhookController,
    ArrearsController,
  ],
  providers: [
    PaymentsService,
    ArrearsService,
    {
      provide: VIVA_ADAPTER,
      // Keep the application bootable without credentials, but make checkout
      // fail closed through an explicitly unavailable (non-mock) adapter.
      useFactory: () => {
        try {
          return createVivaAdapter();
        } catch {
          return new UnavailableVivaAdapter();
        }
      },
    },
    {
      provide: STRIPE_JP_ADAPTER,
      useFactory: () => {
        const secret = process.env.STRIPE_SECRET_KEY?.trim();
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
        return secret && webhookSecret ? createStripeJpAdapter() : undefined;
      },
    },
    {
      provide: STRIPE_ADAPTER,
      useFactory: () => {
        const secret = process.env.STRIPE_SECRET_KEY?.trim();
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
        return secret && webhookSecret ? createStripeAdapter() : undefined;
      },
    },
    {
      provide: MERCADOPAGO_ADAPTER,
      useFactory: () => {
        try {
          return createMercadoPagoAdapter();
        } catch {
          return new UnavailableMercadoPagoAdapter();
        }
      },
    },
  ],
  exports: [ArrearsService],
})
export class PaymentsModule {}
