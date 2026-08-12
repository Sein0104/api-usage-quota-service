import { IsInt, Max, Min } from 'class-validator';

export class CreateUsageEventDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  units!: number;
}
