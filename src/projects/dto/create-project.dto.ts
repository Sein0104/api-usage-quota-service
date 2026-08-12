import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  dailyQuotaUnits!: number;
}
