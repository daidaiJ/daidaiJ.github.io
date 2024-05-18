#!/bin/bash
kubeadm  config images pull --kubernetes-version=v1.29.5  --image-repository=registry.aliyuncs.com/google_containers --cri-socket=unix:///var/run/cri-dockerd.sock
kubeadm init \
--apiserver-advertise-address 192.168.160.11  \
--image-repository registry.aliyuncs.com/google_containers \
--kubernetes-version v1.29.5 \
--service-cidr=10.96.0.0/12 \
--pod-network-cidr=10.244.0.0/16 \
--cri-socket=unix:///var/run/cri-dockerd.sock --v=5

echo "https://blog.csdn.net/MssGuo/article/details/122773155"

mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
export KUBECONFIG=/etc/kubernetes/admin.conf
echo "export KUBECONFIG=/etc/kubernetes/admin.conf" >> /etc/profile
echo "1. exec 'kubeadm join ..(your cmd).. --cri-socket=unix:///var/run/cri-dockerd.sock' at your slave node please append the config '--cri-socket=unix:///var/run/cri-dockerd.sock' "
echo "2. exec 'kubectl apply -f flannel.yml' at your master node and wait until all nodes state is ready "
