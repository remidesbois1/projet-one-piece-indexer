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
                        "group toast !border-white/12 !bg-[#071625] !text-slate-100 group-[.toaster]:shadow-lg font-sans",
                    description: "group-[.toast]:text-slate-400",
                    actionButton:
                        "group-[.toast]:bg-slate-900 group-[.toast]:text-slate-50",
                    cancelButton:
                        "group-[.toast]:bg-white/10 group-[.toast]:text-slate-300",
                    error:
                        "!border-red-400/35 !bg-red-950/90 !text-red-100 group-[.toaster]:shadow-md !p-6 [&_[data-icon]]:text-red-300 [&_[data-title]]:text-lg [&_[data-description]]:text-base [&_[data-description]]:text-red-100/80",
                    success:
                        "!border-emerald-400/35 !bg-emerald-950/90 !text-emerald-100 [&_[data-icon]]:text-emerald-300",
                },
            }}
            {...props}
        />
    )
}

export { Toaster }
