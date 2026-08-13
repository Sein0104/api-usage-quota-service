import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUsageEventDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  @ApiProperty({ maximum: 10_000, minimum: 1, type: 'integer' })
  units!: number;
}
