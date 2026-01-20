import React from 'react';
import AddTomeForm from '../components/AddTomeForm';
import AddChapterForm from '../components/AddChapterForm';
import { Separator } from "@/components/ui/separator"; // Optionnel, sinon une div border-b

const AdminDashboard = () => {
  return (
    <div className="container max-w-4xl mx-auto py-10 px-4 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* En-tête */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-200">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Administration</h1>
          <p className="text-slate-500 mt-2">
            Gérez ici les volumes et chapitres disponibles dans la bibliothèque.
          </p>
        </div>
      </div>

      {/* Section 1 : Tomes */}
      <section>
        <AddTomeForm />
      </section>

      <section>
        <AddChapterForm />
      </section>

    </div>
  );
};

export default AdminDashboard;