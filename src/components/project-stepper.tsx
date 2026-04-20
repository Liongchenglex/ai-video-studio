/**
 * Horizontal stepper navigation for the project workspace.
 * Shows 3 steps: Concept → Style → Script.
 * Steps are clickable for navigation. Shows completion state.
 */
"use client";

import { Check } from "lucide-react";

interface Step {
  label: string;
  description: string;
  completed: boolean;
}

interface ProjectStepperProps {
  currentStep: number;
  steps: Step[];
  onStepClick: (step: number) => void;
}

export function ProjectStepper({
  currentStep,
  steps,
  onStepClick,
}: ProjectStepperProps) {
  return (
    <nav className="mb-8">
      <ol className="flex items-center">
        {steps.map((step, index) => (
          <li key={index} className="flex items-center flex-1">
            <button
              onClick={() => onStepClick(index)}
              className="flex items-center gap-3 group w-full"
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors ${
                  index === currentStep
                    ? "border-primary bg-primary text-primary-foreground"
                    : step.completed
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-muted-foreground/30 text-muted-foreground"
                }`}
              >
                {step.completed && index !== currentStep ? (
                  <Check className="h-4 w-4" />
                ) : (
                  index + 1
                )}
              </div>
              <div className="hidden sm:block text-left">
                <p
                  className={`text-sm font-medium ${
                    index === currentStep
                      ? "text-foreground"
                      : "text-muted-foreground group-hover:text-foreground"
                  }`}
                >
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </button>
            {index < steps.length - 1 && (
              <div
                className={`mx-4 h-px flex-1 ${
                  step.completed ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
