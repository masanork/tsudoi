export type FormField = { field_key: string; label: string; field_type: string; required: number; options_json: string };
export type FormAnswers = Record<string, string | number | string[] | boolean | null>;
