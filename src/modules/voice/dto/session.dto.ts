import { IsArray, IsOptional, IsString } from "class-validator";

export class StartSessionDto {
  @IsString() board!: string;
  @IsString() classLevel!: string;
  @IsString() subject!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) chapterIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) chapterNames?: string[];
  @IsOptional() @IsString() chapter?: string;
}

export class EvaluateDto {
  @IsString() expected!: string;
  @IsString() student!: string;
  @IsOptional() @IsString() concept?: string;
}

export class TutorQueryDto {
  @IsString() query!: string;
  @IsString() sessionId!: string;
}
