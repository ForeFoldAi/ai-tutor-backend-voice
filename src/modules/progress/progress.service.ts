import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";
import { config } from "../../config";
import { AnswerGrade } from "../tutor/interfaces";

@Injectable()
export class ProgressService implements OnModuleInit {
  private readonly log = new Logger(ProgressService.name);
  private pool: Pool | null = null;

  async onModuleInit(): Promise<void> {
    if (!config.databaseUrl) return;
    try {
      this.pool = new Pool({
        connectionString: config.databaseUrl,
        max: 2,
        connectionTimeoutMillis: 3000,
      });
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS rtc_voice_sessions (
          id TEXT PRIMARY KEY,
          student_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          class_level TEXT,
          subject TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          duration_seconds INT DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE IF NOT EXISTS rtc_student_progress (
          student_id TEXT NOT NULL,
          class_level TEXT NOT NULL,
          subject TEXT NOT NULL,
          chapter TEXT NOT NULL DEFAULT '',
          topic TEXT NOT NULL DEFAULT '',
          mastery_score REAL NOT NULL DEFAULT 0,
          correct_count INT NOT NULL DEFAULT 0,
          incorrect_count INT NOT NULL DEFAULT 0,
          partial_count INT NOT NULL DEFAULT 0,
          difficulty INT NOT NULL DEFAULT 3,
          last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (student_id, class_level, subject, chapter, topic)
        );
        CREATE TABLE IF NOT EXISTS rtc_learning_events (
          id BIGSERIAL PRIMARY KEY,
          student_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          class_level TEXT,
          subject TEXT,
          chapter TEXT,
          topic TEXT,
          event_type TEXT NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS rtc_conversation_messages (
          id BIGSERIAL PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } catch (err) {
      this.log.warn(`postgres skip: ${err}`);
      this.pool = null;
    }
  }

  async startSession(row: {
    id: string;
    studentId: string;
    conversationId: string;
    classLevel: string;
    subject: string;
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO rtc_voice_sessions (id, student_id, conversation_id, class_level, subject)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [row.id, row.studentId, row.conversationId, row.classLevel, row.subject],
      );
    } catch (err) {
      this.log.debug(`startSession skip: ${err}`);
    }
  }

  async endSession(id: string, startedAt: number): Promise<void> {
    if (!this.pool) return;
    const duration = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    await this.pool.query(
      `UPDATE rtc_voice_sessions SET ended_at=NOW(), duration_seconds=$2, status='ended' WHERE id=$1`,
      [id, duration],
    );
  }

  async recordMessage(conversationId: string, role: string, content: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO rtc_conversation_messages (conversation_id, role, content) VALUES ($1,$2,$3)`,
      [conversationId, role, content.slice(0, 8000)],
    );
  }

  async recordGrade(opts: {
    studentId: string;
    classLevel: string;
    subject: string;
    chapter: string;
    topic: string;
    grade: AnswerGrade;
    difficulty: number;
    sessionId: string;
  }): Promise<void> {
    if (!this.pool) return;
    try {
    const col =
      opts.grade === "CORRECT"
        ? "correct_count"
        : opts.grade === "INCORRECT"
          ? "incorrect_count"
          : opts.grade === "PARTIALLY_CORRECT"
            ? "partial_count"
            : null;
    if (col) {
      await this.pool.query(
        `INSERT INTO rtc_student_progress
          (student_id, class_level, subject, chapter, topic, ${col}, difficulty, last_interaction_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,NOW())
         ON CONFLICT (student_id, class_level, subject, chapter, topic) DO UPDATE SET
           ${col} = rtc_student_progress.${col} + 1,
           difficulty = $6,
           last_interaction_at = NOW(),
           mastery_score = LEAST(1.0, GREATEST(0,
             (rtc_student_progress.correct_count + (CASE WHEN $7='CORRECT' THEN 1 ELSE 0 END))::real /
             NULLIF(rtc_student_progress.correct_count + rtc_student_progress.incorrect_count
               + rtc_student_progress.partial_count + 1, 0)))`,
        [
          opts.studentId,
          opts.classLevel,
          opts.subject,
          opts.chapter,
          opts.topic || "general",
          opts.difficulty,
          opts.grade,
        ],
      );
    }
    await this.pool.query(
      `INSERT INTO rtc_learning_events
        (student_id, session_id, class_level, subject, chapter, topic, event_type, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        opts.studentId,
        opts.sessionId,
        opts.classLevel,
        opts.subject,
        opts.chapter,
        opts.topic,
        "answer_evaluated",
        JSON.stringify({ grade: opts.grade, difficulty: opts.difficulty }),
      ],
    );
    } catch (err) {
      this.log.debug(`progress skip: ${err}`);
    }
  }

  async studentProgress(studentId: string) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM rtc_student_progress WHERE student_id=$1 ORDER BY last_interaction_at DESC LIMIT 50`,
      [studentId],
    );
    return rows;
  }

  async conversationMessages(conversationId: string) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT role, content, created_at FROM rtc_conversation_messages
       WHERE conversation_id=$1 ORDER BY id ASC LIMIT 200`,
      [conversationId],
    );
    return rows;
  }
}
