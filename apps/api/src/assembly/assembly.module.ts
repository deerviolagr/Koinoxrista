import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { LLM_PROVIDER, createLlmProvider } from '../assistant/llm-provider';
import { AssemblyController } from './assembly.controller';
import { AssemblyService } from './assembly.service';

@Module({
  imports: [AuthModule, AuditModule, PermissionsModule, TenancyModule],
  controllers: [AssemblyController],
  providers: [
    AssemblyService,
    { provide: LLM_PROVIDER, useFactory: createLlmProvider },
  ],
  exports: [AssemblyService],
})
export class AssemblyModule {}
