---
title: "{{ replace .TranslationBaseName "-" " " | title }}"
slug: ""
description: ""
date: {{ .Date }}
lastmod: {{ .Date }}
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: [""]
tags: ["golang"]
image: https://picsum.photos/seed/{{ substr (md5 (.Date)) 4 8 }}/800/600
---