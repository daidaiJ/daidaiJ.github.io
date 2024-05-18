#!/bin/bash

# 配置必要工具
dnf install -y conntrack   iptables curl sysstat libseccomp wget vim net-tools  iproute-tc


# 配置ntp
dnf install -y net-tools  chrony    ipvsadm ipset  yum-utils device-mapper-persistent-data lvm2
sed -i '3,6 s/^/# /' /etc/chrony.conf
sed -i '6 a server ntp.aliyun.com iburst' /etc/chrony.conf
systemctl enable chronyd --now

#  关闭防火墙
systemctl stop firewalld && systemctl disable firewalld
# 关闭selinux
sed -i 's/enforcing/disabled/' /etc/selinux/config

# 安装相应组件

dnf -y install iptables-services && systemctl start iptables && systemctl enable iptables && iptables -F && service iptables save
# 开启模块
modprobe br_netfilter
modprobe overlay
# 写入内核配置
cat > /etc/sysctl.d/k8s.conf << EOF
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
vm.swappiness = 0
EOF


# 启用内核配置
sysctl --system

cat <<EOF | sudo tee /etc/modules-load.d/ipvs.conf
ip_vs
ip_vs_rr
ip_vs_wrr
ip_vs_sh
nf_conntrack
EOF

modprobe  ip_vs
modprobe  ip_vs_rr
modprobe  ip_vs_wrr
modprobe  ip_vs_sh
modprobe  nf_conntrack
lsmod | grep -e ip_vs -e nf_conntrack
# 首先写入配置的 host

cat >> /etc/hosts << EOF
192.168.160.11 master
192.168.160.12 node1
192.168.160.13 node2
EOF

# 添加 repo 源
yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
yum -y install docker-ce
# 创建docker 文件夹
mkdir -p /etc/docker
# 写入配置
sudo tee /etc/docker/daemon.json <<-'EOF'
{
    "registry-mirrors": [
        "https://registry.docker-cn.com",
        "https://docker.mirrors.ustc.edu.cn",
        "https://hub-mirror.c.163.com",
        "https://mirror.baidubce.com",
        "https://ccr.ccs.tencentyun.com"],
    "exec-opts": ["native.cgroupdriver=systemd"],
    "storage-driver": "overlay2",
    "log-driver":"json-file",
    "log-opts":{
        "max-size":"10m"
    }

}
EOF

cat > /etc/systemd/system/docker.service.d <<EOF
[Unit]
Description=Docker Application Container Engine
Documentation=https://docs.docker.com
After=network-online.target docker.socket firewalld.service
Wants=network-online.target
Requires=docker.socket
 
[Service]
Type=notify
ExecStart=/usr/bin/dockerd -H fd://
ExecReload=/bin/kill -s HUP $MAINPID
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=0
Delegate=yes
KillMode=process
Restart=on-failure
StartLimitBurst=3
StartLimitInterval=60s
 
[Install]
WantedBy=multi-user.target

EOF
 
#重启docker服务
systemctl daemon-reload && systemctl restart docker && systemctl enable docker

[ ! -f "cri-dockerd-0.3.14-3.el8.x86_64.rpm" ] && wget -c https://github.com/Mirantis/cri-dockerd/releases/download/v0.3.14/cri-dockerd-0.3.14-3.el8.x86_64.rpm
dnf install -y cri-dockerd-0.3.14-3.el8.x86_64.rpm

cat > /usr/lib/systemd/system/cri-docker.service <<EOF
[Unit]
Description=CRI Interface for Docker Application Container Engine
Documentation=https://docs.mirantis.com
After=network-online.target firewalld.service docker.service
Wants=network-online.target
Requires=cri-docker.socket
 
[Service]
Type=notify
ExecStart=/usr/bin/cri-dockerd --network-plugin=cni --pod-infra-container-image=registry.aliyuncs.com/google_containers/pause:3.9
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutSec=0
RestartSec=2
Restart=always
 
StartLimitBurst=3
 
StartLimitInterval=60s
 
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
 
TasksMax=infinity
Delegate=yes
KillMode=process
 
[Install]
WantedBy=multi-user.target
EOF


cat > /usr/lib/systemd/system/cri-docker.socket <<EOF
[Unit]
Description=CRI Docker Socket for the API
PartOf=cri-docker.service
 
[Socket]
ListenStream=%t/cri-dockerd.sock
SocketMode=0660
SocketUser=root
SocketGroup=docker
 
[Install]
WantedBy=sockets.target
EOF

systemctl daemon-reload 
systemctl enable cri-docker && systemctl start cri-docker && systemctl status cri-docker

# 配置 k8s 1.29 源
cat <<EOF | tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.29/rpm/
enabled=1
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.29/rpm/repodata/repomd.xml.key
EOF
setenforce 0
yum install -y kubelet kubeadm kubectl
cp /etc/sysconfig/kubelet{,.bak}
cat > /etc/sysconfig/kubelet <<EOF
KUBELET_EXTRA_ARGS="--cgroup-driver=systemd"
EOF

systemctl enable kubelet 

yum install bash-completion -y 
source /usr/share/bash-completion/bash_completion
echo "source <(kubectl completion bash)" >> ~/.bashrc
source  ~/.bashrc   

