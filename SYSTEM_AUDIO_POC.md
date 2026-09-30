# Prova de conceito: áudio do sistema no macOS

## Resultado

O teste foi executado neste Mac (macOS 27.0.1) com `Core Audio Taps` e recebeu
áudio do sistema enquanto o som continuou na saída padrão: `1.407` callbacks e
pico de sinal `0,7447` ao reproduzir um alerta local. Portanto, o Teams pode
ser transcrito sem BlackHole e sem alterar os fones selecionados como saída.

## Caminho escolhido

Use `Core Audio Taps` como a fonte nativa de áudio do sistema. A API é
suportada a partir do macOS 14.2 e pede uma única autorização de gravação de
áudio do sistema. A descrição dessa autorização precisa estar no `Info.plist`
do aplicativo distribuído (`NSAudioCaptureUsageDescription`).

O `ScreenCaptureKit` também foi testado como alternativa para macOS 13+, mas
entregou buffers silenciosos nesta máquina. Ele não será usado para a captura
principal.

## Reproduzir a prova

```sh
xcrun swiftc -parse-as-library scripts/coreaudio_tap_poc.swift \
  -o /tmp/opencluely-coreaudio-tap-poc \
  -framework CoreAudio -framework AudioToolbox
/tmp/opencluely-coreaudio-tap-poc 15
```

Reproduza uma chamada ou um som local durante os 15 segundos. A saída final
mostra a quantidade de callbacks e o pico do sinal. Para o primeiro teste
empacotado, use `scripts/SystemAudioPOC-Info.plist`; o macOS solicitará a
autorização de áudio do sistema ao iniciar o dispositivo agregado.

## Compatibilidade planejada

| macOS | Fonte de áudio recomendada |
| --- | --- |
| 14.2 ou posterior | Core Audio Tap nativo |
| 13 até 14.1 | BlackHole como alternativa |

## Integração no app

O helper nativo deverá produzir PCM mono de 16 kHz para o mesmo buffer que já
alimenta o Whisper. A interface exibirá `Áudio do sistema (macOS)` como fonte,
pedirá a autorização quando ativada e manterá o medidor de nível. O microfone
externo e os fones continuam independentes dessa fonte.
