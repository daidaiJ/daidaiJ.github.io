---
title: "{{ replace .TranslationBaseName "-" " " | title }}"
slug: ""
description: ""
date: {{ .Date }}
lastmod: {{ .Date }}
draft: false
toc: true
weight: false
musicid: 5264842
categories: [""]
tags: ["golang"]
image: https://picsum.photos/seed/{{ substr (md5 (.Date)) 4 8 }}/800/600
---