"use client";
import { MangaProvider } from "@/context/MangaContext";

export default function MangaLayout({ children }) {
    return (
        <MangaProvider>
            {children}
        </MangaProvider>
    );
}
