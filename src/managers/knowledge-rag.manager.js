/**
 * Candidate Knowledge Base & STAR RAG Manager
 * Manages candidate real-world projects, architectural cases, and STAR behavioral stories.
 * Provides high-speed semantic/keyword retrieval to inject real experience into LLM answers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../core/logger').createServiceLogger('KNOWLEDGE_RAG');

class KnowledgeRagManager {
  constructor() {
    this.storageDir = path.join(os.homedir(), '.OpenCluely');
    this.storageFile = path.join(this.storageDir, 'candidate-knowledge.json');
    this.items = [];
    this.isInitialized = false;
    this.initialize();
  }

  initialize() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }

      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        this.items = JSON.parse(raw);
        logger.info('Loaded candidate knowledge items from storage', { count: this.items.length });
      } else {
        // Seed default STAR cases
        this.items = this.getDefaultSeedItems();
        this.save();
        logger.info('Initialized default STAR knowledge items', { count: this.items.length });
      }

      this.isInitialized = true;
    } catch (err) {
      logger.error('Failed to initialize KnowledgeRagManager', { error: err.message });
      this.items = this.getDefaultSeedItems();
    }
  }

  getDefaultSeedItems() {
    return [
      {
        id: 'star-1',
        title: 'Otimização de Concorrência & Latência (FinTech / Backend)',
        role: 'Senior Backend Engineer',
        tags: ['concorrência', 'latência', 'redis', 'kafka', 'performance', 'database', 'escala', 'microsserviços'],
        keywords: ['concorrência', 'latência', 'redis', 'kafka', 'performance', 'database', 'escala', 'microsserviços'],
        situation: 'Sistema financeiro enfrentava picos de 40.000 requisições/s com contenção no PostgreSQL e latência p99 de 850ms.',
        task: 'Reduzir a latência para menos de 50ms e eliminar deadlocks sem perder consistência transacional.',
        action: 'Implementei padrão Cache-Aside com Redis Cluster + pipeline assíncrono com Kafka, aplicando optimistic locking no banco.',
        result: 'Latência p99 caiu de 850ms para 42ms (-95%), suportando picos sem degradação e gerando economia de 40% em infraestrutura cloud.'
      },
      {
        id: 'star-2',
        title: 'Resolução de Incidente Crítico P0 em Produção',
        role: 'Tech Lead / SRE',
        tags: ['incidente', 'bug', 'produção', 'troubleshooting', 'postmortem', 'resiliência'],
        keywords: ['incidente', 'bug', 'produção', 'troubleshooting', 'postmortem', 'resiliência'],
        situation: 'Falha em cascata de serviços durante deploy de sexta-feira derrubou autenticação de 500k usuários ativos.',
        task: 'Restabelecer serviço em menos de 15 minutos e identificar a causa raiz sem perda de dados.',
        action: 'Executei rollback imediato via blue/green deployment, analisei logs distribuídos (Datadog/Jaeger) e encontrei memory leak em pool de conexões.',
        result: 'Serviço recuperado em 9 minutos; implementei healthchecks granulares, circuit breaker e conduzi post-mortem blameless com o time.'
      },
      {
        id: 'star-3',
        title: 'Refatoração de Monólito para Microsserviços / Arquitetura Limpa',
        role: 'Software Architect',
        tags: ['arquitetura', 'microsserviços', 'monólito', 'clean architecture', 'ddd', 'design system'],
        keywords: ['arquitetura', 'microsserviços', 'monólito', 'clean architecture', 'ddd', 'design system'],
        situation: 'Monólito legado com 8 anos de débito técnico onde cada deploy levava 4 horas e causava regressões frequentes.',
        task: 'Arquitetar desacoplamento modular usando princípios de DDD (Domain-Driven Design) e Event-Driven Architecture.',
        action: 'Defini bounded contexts, criei APIs REST e gRPC com contratos estritos e migrei módulos gradualmente usando padrão Strangler Fig.',
        result: 'Tempo de build/deploy caiu de 4 horas para 12 minutos; tempo de onboarding de novos devs reduziu em 60%.'
      },
      {
        id: 'star-4',
        title: 'Liderança Técnica & Mentoria de Engenharia',
        role: 'Engineering Manager',
        tags: ['liderança', 'mentoria', 'gestão', 'conflito', 'cultura', 'equipe'],
        keywords: ['liderança', 'mentoria', 'gestão', 'conflito', 'cultura', 'equipe'],
        situation: 'Equipe de 6 engenheiros com divergências sobre adoção de TypeScript/Rust e falta de padronização em code reviews.',
        task: 'Alinhar o time tecnicamente, acelerar entregas e elevar a maturidade de engenharia sem impor decisões top-down.',
        action: 'Criei RFCs (Request for Comments) colaborativos, institui pair programming diário e defini guidelines objetivos de code review.',
        result: 'Velocidade da sprint subiu 35% e bugs em produção caíram 50%; dois engenheiros foram promovidos a plenos/seniores.'
      }
    ];
  }

  save() {
    try {
      fs.writeFileSync(this.storageFile, JSON.stringify(this.items, null, 2), 'utf8');
      return true;
    } catch (err) {
      logger.error('Failed to save knowledge items to disk', { error: err.message });
      return false;
    }
  }

  getItems() {
    return this.items || [];
  }

  getAllItems() {
    return this.getItems();
  }

  getItem(id) {
    return this.items.find(i => i.id === id) || null;
  }

  saveItem(item) {
    if (!item) return null;
    const rawTags = item.keywords || item.tags || [];
    const parsedTags = Array.isArray(rawTags) 
      ? rawTags 
      : String(rawTags).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

    const cleanItem = {
      id: item.id || `star-${Date.now()}`,
      title: (item.title || 'Novo Case').trim(),
      role: (item.role || '').trim(),
      tags: parsedTags,
      keywords: parsedTags,
      situation: (item.situation || '').trim(),
      task: (item.task || '').trim(),
      action: (item.action || '').trim(),
      result: (item.result || '').trim(),
      updatedAt: new Date().toISOString()
    };

    const index = this.items.findIndex(i => i.id === cleanItem.id);
    if (index >= 0) {
      this.items[index] = cleanItem;
    } else {
      this.items.unshift(cleanItem);
    }

    this.save();
    logger.info('Knowledge item saved', { id: cleanItem.id, title: cleanItem.title });
    return cleanItem;
  }

  deleteItem(id) {
    const beforeCount = this.items.length;
    this.items = this.items.filter(i => i.id !== id);
    if (this.items.length !== beforeCount) {
      this.save();
      logger.info('Knowledge item deleted', { id });
      return true;
    }
    return false;
  }

  findRelevantCases(queryText, limit = 1) {
    return this.findRelevantStories(queryText, limit);
  }

  /**
   * Fast keyword & semantic relevance ranking.
   * Matches candidate questions/topics against stored STAR stories.
   */
  findRelevantStories(queryText, limit = 1) {
    if (!queryText || typeof queryText !== 'string' || this.items.length === 0) {
      return [];
    }

    const cleanQuery = queryText.toLowerCase();
    const queryTokens = cleanQuery
      .replace(/[^\w\s\u00C0-\u00FF]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    if (queryTokens.length === 0) return [];

    const scored = this.items.map(item => {
      let score = 0;
      const titleLower = (item.title || '').toLowerCase();
      const tagsLower = (item.tags || []).map(t => t.toLowerCase());
      const bodyLower = `${item.situation} ${item.task} ${item.action} ${item.result}`.toLowerCase();

      queryTokens.forEach(token => {
        // High weight: tag matches
        if (tagsLower.includes(token)) score += 5;
        // High weight: title matches
        if (titleLower.includes(token)) score += 4;
        // Medium weight: body matches
        if (bodyLower.includes(token)) score += 1.5;
      });

      return { item, score };
    });

    const relevant = scored
      .filter(s => s.score >= 3.0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.item);

    return relevant;
  }

  /**
   * Format matched stories as ready-to-inject prompt context.
   */
  formatPromptInjection(queryText) {
    const relevant = this.findRelevantStories(queryText, 1);
    if (relevant.length === 0) return '';

    const story = relevant[0];
    return `
## 🎯 CASO REAL DO CANDIDATO RELACIONADO (Método STAR - Incorpore estas métricas reais na resposta):
- **Projeto/Experiência**: ${story.title}
- **Situação**: ${story.situation}
- **Tarefa**: ${story.task}
- **Ação Prática**: ${story.action}
- **Resultado Quantificável**: ${story.result}
*(Use este case concreto e métricas autênticas na sua resposta para demonstrar senioridade prática comprovada)*
`;
  }
}

module.exports = new KnowledgeRagManager();
