import type { TaskType } from "@foxban/shared";
export type EditableTaskType = Exclude<TaskType, "subtask">;

export const TASK_TYPES: EditableTaskType[] = ["epic", "spike", "task", "bug"];

export const TASK_TYPE_META: Record<
  TaskType,
  { label: string; stripe: string; swatch: string; pill: string }
> = {
  epic: {
    label: "Epic",
    stripe: "border-l-purple-500",
    swatch: "bg-purple-500",
    pill: "bg-purple-100 text-purple-800",
  },
  spike: {
    label: "Spike",
    stripe: "border-l-blue-500",
    swatch: "bg-blue-500",
    pill: "bg-blue-100 text-blue-800",
  },
  task: {
    label: "Task",
    stripe: "border-l-yellow-500",
    swatch: "bg-yellow-500",
    pill: "bg-yellow-100 text-yellow-800",
  },
  bug: {
    label: "Bug",
    stripe: "border-l-red-500",
    swatch: "bg-red-500",
    pill: "bg-red-100 text-red-800",
  },
  subtask: {
    label: "Subtask",
    stripe: "border-l-teal-500",
    swatch: "bg-teal-500",
    pill: "bg-teal-100 text-teal-800",
  },
};
