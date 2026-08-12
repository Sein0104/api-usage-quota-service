import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { API_SCOPE_ORDER } from '../api-key.scopes.js';

export class CreateApiKeyDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(API_SCOPE_ORDER, { each: true })
  scopes!: (typeof API_SCOPE_ORDER)[number][];
}
