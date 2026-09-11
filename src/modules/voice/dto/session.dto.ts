import { IsArray, IsOptional, IsString, ValidateIf } from "class-validator";

export class StartSessionDto {
  /** Required for chapter voice; optional when agentMode is set (Ask AI Tutor). */
  @ValidateIf((o: StartSessionDto) => !o.agentMode)
  @IsString()
  board!: string;
  @ValidateIf((o: StartSessionDto) => !o.agentMode)
  @IsString()
  classLevel!: string;
  @ValidateIf((o: StartSessionDto) => !o.agentMode)
  @IsString()
  subject!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) chapterIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) chapterNames?: string[];
  @IsOptional() @IsString() chapter?: string;
  /** Ask AI Tutor: free | ask | practice | explain */
  @IsOptional() @IsString() agentMode?: string;
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
