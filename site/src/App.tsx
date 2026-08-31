import { SiteHeader } from "@/components/site-header";
import { Hero } from "@/components/sections/hero";
import { Features } from "@/components/sections/features";
import { Console } from "@/components/sections/console";
import { Architecture } from "@/components/sections/architecture";
import { Install } from "@/components/sections/install";
import { SiteFooter } from "@/components/site-footer";

export default function App() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Features />
        <Console />
        <Architecture />
        <Install />
      </main>
      <SiteFooter />
    </>
  );
}
