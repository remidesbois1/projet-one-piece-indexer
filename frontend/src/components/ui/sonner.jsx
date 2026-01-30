"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"

const Toaster = ({ ...props }) => {
    const { theme = "system" } = useTheme()

    return (
        <Sonner
            theme={theme}
            className="toaster group"
            toastOptions={{
                classNames: {
                    toast:
                        "group toast group-[.toaster]:bg-white group-[.toaster]:text-slate-950 group-[.toaster]:border-slate-200 group-[.toaster]:shadow-lg font-sans",
                    description: "group-[.toast]:text-slate-500",
                    actionButton:
                        "group-[.toast]:bg-slate-900 group-[.toast]:text-slate-50",
                    cancelButton:
                        "group-[.toast]:bg-slate-100 group-[.toast]:text-slate-500",
                    error:
                        "group-[.toaster]:bg-red-50 group-[.toaster]:text-red-900 group-[.toaster]:border-red-200 group-[.toaster]:shadow-md !p-6 [&_[data-icon]]:text-red-600 [&_[data-title]]:text-lg [&_[data-description]]:text-base [&_[data-description]]:text-red-800/90",
                    success:
                        "group-[.toaster]:bg-emerald-50 group-[.toaster]:text-emerald-900 group-[.toaster]:border-emerald-200 [&_[data-icon]]:text-emerald-600",
                },
            }}
            {...props}
        />
    )
}

export { Toaster }
