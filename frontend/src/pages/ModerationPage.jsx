import React from 'react';
import BubbleReviewList from '../components/BubbleReviewList';
import PageReviewList from '../components/PageReviewList';

// Shadcn Components
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

const ModerationPage = () => {
  return (
    <div className="container max-w-5xl mx-auto py-10 px-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header */}
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Espace Modération
        </h1>
        <p className="text-slate-500 text-lg">
          Vérifiez les traductions et validez les pages finales.
        </p>
      </div>

      {/* Tabs Navigation */}
      <Tabs defaultValue="bubbles" className="w-full">
        <TabsList className="grid w-full max-w-[400px] grid-cols-2 mb-8">
          <TabsTrigger value="bubbles">Bulles à valider</TabsTrigger>
          <TabsTrigger value="pages">Pages complètes</TabsTrigger>
        </TabsList>

        <TabsContent value="bubbles" className="min-h-[300px]">
          {/* Note: Assure-toi que BubbleReviewList est aussi mis à jour si nécessaire, 
              sinon il fonctionnera quand même à l'intérieur de cet onglet */}
          <BubbleReviewList />
        </TabsContent>

        <TabsContent value="pages" className="min-h-[300px]">
          <PageReviewList />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ModerationPage;