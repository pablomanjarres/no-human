# Integración Front-End: 5 Agentes de Ingeniería & Engineering Dashboard

Este documento define la arquitectura, componentes e interfaz de usuario para la suite de **5 Agentes de Ingeniería** y el **Engineering Dashboard (SaaS Industrial)** del proyecto `no-human`.

## Arquitectura de 5 Agentes de Ingeniería

```
                       +-------------------------------+
                       | 1. INTAKE AGENT               |
                       | Entiende texto, migración     |
                       | Keyence, fotos y PDFs         |
                       +---------------+---------------+
                                       |
                                       v
                       +---------------+---------------+
                       | 2. REQUIREMENT AGENT          |
                       | Convierte a chips de          |
                       | requisitos técnicos           |
                       +---------------+---------------+
                                       |
                                       v
                       +---------------+---------------+
                       | 3. CATALOG AGENT              |
                       | Busca candidatos en productos |
                       | del catálogo SICK             |
                       +---------------+---------------+
                                       |
                                       v
                       +---------------+---------------+
                       | 4. COMPARISON AGENT           |
                       | Matriz de specs, ventajas y   |
                       | compatibilidad                |
                       +---------------+---------------+
                                       |
                                       v
                       +---------------+---------------+
                       | 5. CHALLENGER AGENT (ALERTA)  |
                       | "¿Qué podría salir mal?"      |
                       | Stress test & Riesgos         |
                       +-------------------------------+
```

## Definición de los 5 Agentes

1. **Intake Agent**: Procesa entradas en lenguaje natural, fotos de etiquetas industriales, referencias de competidores (ej: *Keyence LR-T5000*) y datasheets PDF.
2. **Requirement Agent**: Normaliza y extrae parámetros técnicos clave organizados en chips (*Distancia, Objeto, Entorno IP67/IP69K, Salida PNP/IO-Link, Velocidad, Montaje*).
3. **Catalog Agent**: Realiza búsquedas y filtrado de alta velocidad sobre el catálogo de más de 50.000 referencias de SICK.
4. **Comparison Agent**: Compila la tabla comparativa de candidatos especificando compatibilidad (ej: *100% Pin-to-pin M12*), ventajas ópticas y mecánicas.
5. **Challenger Agent (Destacado en Amarillo)**: Agente crítico de estrés operativo. Analiza factores ambientales desfavorables (*condensación, cambios térmicos >40°C, reflectividad de superficies pulidas*) y emite advertencias preventivas.

## Estructura de la Interfaz (Engineering Dashboard SaaS)

- **Estilo Visual**: Industrial serio ("Startup Melo"), fondo claro (`#f8fafc`), Azul Técnico (`#0041C3`), Amarillo (`#f59e0b`) para alertas del Challenger Agent y Verde (`#10b981`) para recomendaciones finales verificadas.
- **Vista Inicial**: Chatbot integrado con accesos rápidos (*"Keyence -> SICK"*, *"Botellas transparentes"*, *"Subir Datasheet"*). En análisis complejos incluye el botón **`Open Engineering Dashboard`**.
- **Engineering Dashboard Layout**:
  - **Panel Izquierdo**: Hilo de conversación e insumos adjuntos.
  - **Panel Centro**: Chips de Requisitos Técnicos + Tarjeta de Recomendación Verificada.
  - **Panel Derecha**: Estado en vivo de los 5 Agentes de Ingeniería.
  - **Panel Inferior**: Tabla Comparativa de Productos Candidatos SICK + Tarjeta de Riesgos Operativos del **Challenger Agent** (Amarillo).
