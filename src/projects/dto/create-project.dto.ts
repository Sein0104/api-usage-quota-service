import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  @ApiProperty({
    maxLength: 100,
    minLength: 1,
    pattern: '^\\S(?:[\\s\\S]*\\S)?$',
  })
  name!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  @ApiProperty({ maximum: 1_000_000_000, minimum: 1, type: 'integer' })
  dailyQuotaUnits!: number;
}
