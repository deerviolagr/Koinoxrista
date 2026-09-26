import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { INVITABLE_ROLES } from '../roles';

export class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsIn(INVITABLE_ROLES, {
    message: 'role cannot be invited',
  })
  role!: (typeof INVITABLE_ROLES)[number];

  @IsOptional()
  @IsString()
  unitId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}
